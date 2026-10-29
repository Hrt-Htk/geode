// #559: the change-passphrase / re-key modal: a thin obsidian shell for
// input collection (form, resume form, choose). The run lifecycle lives in
// RekeyRunView. After a reload, an open cursor reopens the modal in the
// resume form: the vault is still on the old keys until the switch, so the
// current passphrase is re-entered and the new keys re-derived from the
// cursor's params. No passphrase or key ever lands in the cursor.
import { App, ButtonComponent, Modal, Setting, ToggleComponent } from "obsidian";
import { b64decode } from "../../core/protocol.ts";
import { checkVerifier, deriveAuthKey, deriveKeys, type VaultKeys } from "../../core/crypto.ts";
import { toHex } from "../../core/hash.ts";
import { makeRekeyClient } from "../plumbing/rekey-client.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { log } from "../plumbing/log.ts";
import { getServerStorage } from "../plumbing/storage-client.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import {
  enumerateWork,
  RekeyAborted,
  type RekeyCursor,
  type RekeyCursorStore,
  type RekeyKind,
  type RekeyMode,
  type RekeyWorkList,
  rowBatchesOf,
} from "../sync/rekey-run.ts";
import {
  type NetworkProbe,
  probeNetwork,
  probeSample,
  type RekeyChoice,
  rekeyPlan,
} from "./rekey-estimate.ts";
import { logTimed, traceListing } from "./rekey-estimate-trace.ts";
import {
  ENCRYPTION_PARAMS,
  type EncryptionLevel,
  STRENGTH_NOTE,
  STRENGTH_OPTIONS,
} from "./setup-wizard-logic.ts";
import { WRONG_PASSPHRASE } from "./passphrase-copy.ts";
import {
  CHANGE_WARNING,
  CHECKBOX_CHANGE,
  CHECKBOX_REKEY,
  CONFIRM_PASSPHRASE_LABEL,
  CONTINUE_BUTTON,
  COPY_OPTION_DESC,
  COPY_OPTION_NAME,
  CURRENT_PASSPHRASE_LABEL,
  ESTIMATING,
  initialRekeyUiState,
  NEW_PASSPHRASE_LABEL,
  REKEY_TITLES,
  REKEY_WARNING,
  rekeyFormGate,
  rekeyFormHint,
  rekeySubmitError,
  type RekeyUiState,
  rekeyUiTransition,
  REPLACE_OPTION_DESC,
  REPLACE_OPTION_NAME,
  RESUME_BUTTON,
  RESUME_FORM_TITLE,
  START_BUTTON,
  STRENGTH_ROW_NAME,
} from "./rekey-modal-logic.ts";
import { RekeyRunView } from "./rekey-run-view.ts";

export type RekeyModalHost = {
  settings: () => PluginSettings;
  keys: () => VaultKeys | null;
  isMobile: boolean;
  cursor: () => RekeyCursorStore;
  finishRekey: (
    newKeys: VaultKeys,
    params: { ops: number; mem: number },
    verifierB64: string,
  ) => Promise<void>;
};

export class RekeyModal extends Modal {
  private state: RekeyUiState;
  private kind: RekeyKind;
  private level: EncryptionLevel = "standard";
  private resuming = false;
  private saved: RekeyCursor | null = null;
  private newKeys: VaultKeys | null = null;
  private params: { ops: number; mem: number } | null = null;
  private work: RekeyWorkList | null = null;
  private vaultBytes = 0;
  private choice: RekeyChoice | null = null;
  private mode: RekeyMode | null = null;
  private understood = false;
  private estimateController: AbortController | null = null;
  private runView: RekeyRunView | null = null;
  private formInputs: HTMLInputElement[] = [];
  private continueBtn: ButtonComponent | null = null;
  private startBtn: ButtonComponent | null = null;
  private copyToggle: ToggleComponent | null = null;
  private replaceToggle: ToggleComponent | null = null;
  private formErrorEl: HTMLElement | null = null;
  private estimateEl: HTMLElement | null = null;
  private chooseEl: HTMLElement | null = null;

  constructor(
    app: App,
    private host: RekeyModalHost,
    entryKind: RekeyKind,
  ) {
    super(app);
    this.kind = entryKind;
    this.state = initialRekeyUiState(entryKind);
  }

  onOpen(): void {
    this.modalEl.dataset.testid = "geode-rekey-modal";
    this.saved = this.host.cursor().load();
    if (this.saved) {
      // The cursor stores the run's kind: the success line matches the run,
      // not the entry point.
      this.kind = this.saved.kind;
      this.resuming = true;
      this.state = { ...initialRekeyUiState(this.kind), phase: "resume", mode: this.saved.mode };
      this.setTitle(REKEY_TITLES[this.kind]);
      this.renderResumeForm();
    } else {
      this.setTitle(REKEY_TITLES[this.kind]);
      this.renderForm();
    }
  }

  onClose(): void {
    this.estimateController?.abort();
    this.runView?.dispose();
    this.contentEl.empty();
  }

  // ── Form phase ────────────────────────────────────────────────────────────

  private renderForm(): void {
    this.resuming = false;
    const { contentEl } = this;
    contentEl.empty();
    this.formInputs = [];
    const fields = this.kind === "change"
      ? [CURRENT_PASSPHRASE_LABEL, NEW_PASSPHRASE_LABEL, CONFIRM_PASSPHRASE_LABEL]
      : [CURRENT_PASSPHRASE_LABEL];
    const testids = ["geode-rekey-current", "geode-rekey-new", "geode-rekey-confirm"];
    fields.forEach((label, i) => {
      new Setting(contentEl).setName(label).addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.dataset.testid = testids[i];
        t.inputEl.addEventListener("input", () => this.updateFormGate());
        this.formInputs.push(t.inputEl);
      });
    });
    if (this.kind === "rekey") {
      new Setting(contentEl).setName(STRENGTH_ROW_NAME).setDesc(STRENGTH_NOTE).addDropdown((d) => {
        for (const level of Object.keys(STRENGTH_OPTIONS) as EncryptionLevel[]) {
          d.addOption(level, STRENGTH_OPTIONS[level]);
        }
        d.setValue(this.level);
        d.onChange((v) => {
          this.level = v as EncryptionLevel;
        });
        d.selectEl.dataset.testid = "geode-rekey-strength";
      });
    }
    this.formErrorEl = contentEl.createEl("p", {
      cls: "geode-warn",
      text: "",
      attr: { "data-testid": "geode-rekey-form-error" },
    });
    new Setting(contentEl).addButton((b) => {
      this.continueBtn = b;
      b.setCta().setButtonText(CONTINUE_BUTTON);
      b.buttonEl.dataset.testid = "geode-rekey-continue";
      b.buttonEl.disabled = true;
      b.onClick(() => void this.submitForm());
    });
    this.formInputs[0]?.focus();
  }

  // ── Resume form (after a reload, on a saved cursor) ───────────────────────

  private renderResumeForm(): void {
    this.resuming = true;
    const { contentEl } = this;
    contentEl.empty();
    this.formInputs = [];
    contentEl.createEl("p", {
      text: RESUME_FORM_TITLE,
      attr: { "data-testid": "geode-rekey-resume-title" },
    });
    const fields = this.kind === "change"
      ? [CURRENT_PASSPHRASE_LABEL, NEW_PASSPHRASE_LABEL]
      : [CURRENT_PASSPHRASE_LABEL];
    const testids = ["geode-rekey-resume-current", "geode-rekey-resume-new"];
    fields.forEach((label, i) => {
      new Setting(contentEl).setName(label).addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.dataset.testid = testids[i];
        t.inputEl.addEventListener("input", () => this.updateFormGate());
        this.formInputs.push(t.inputEl);
      });
    });
    this.formErrorEl = contentEl.createEl("p", {
      cls: "geode-warn",
      text: "",
      attr: { "data-testid": "geode-rekey-form-error" },
    });
    new Setting(contentEl).addButton((b) => {
      this.continueBtn = b;
      b.setCta().setButtonText(RESUME_BUTTON);
      b.buttonEl.dataset.testid = "geode-rekey-resume-submit";
      b.buttonEl.disabled = true;
      b.onClick(() => void this.submitResume());
    });
    this.formInputs[0]?.focus();
  }

  private readValues(): { current: string; next: string; confirm: string } {
    const [current, next, confirm] = this.formInputs;
    const nextVal = next?.value ?? "";
    return {
      current: current?.value ?? "",
      next: nextVal,
      // The resume form has no confirm field; the new passphrase stands in.
      confirm: this.resuming ? nextVal : confirm?.value ?? "",
    };
  }

  private updateFormGate(): void {
    const values = { ...this.readValues(), level: this.level };
    this.continueBtn?.buttonEl.toggleAttribute("disabled", !rekeyFormGate(this.kind, values));
    this.formErrorEl?.setText(rekeyFormHint(this.kind, values) ?? "");
  }

  private async submitForm(): Promise<void> {
    const values = { ...this.readValues(), level: this.level };
    const error = rekeySubmitError(this.kind, values);
    if (error) {
      this.formErrorEl?.setText(error);
      return;
    }
    const s = this.host.settings();
    const salt = b64decode(s.salt);
    const current = await deriveKeys(values.current, salt, {
      opsLimit: s.argon2Params.ops,
      memLimit: s.argon2Params.mem,
    });
    if (s.verifier && !(await checkVerifier(current, b64decode(s.verifier)))) {
      this.formErrorEl?.setText(WRONG_PASSPHRASE);
      return;
    }
    // Change keeps the vault's params (only the passphrase moves); re-key keeps
    // the passphrase and moves to the chosen level's params.
    this.params = this.kind === "change" ? s.argon2Params : ENCRYPTION_PARAMS[this.level];
    const passphrase = this.kind === "change" ? values.next : values.current;
    this.newKeys = await deriveKeys(passphrase, salt, {
      opsLimit: this.params.ops,
      memLimit: this.params.mem,
    });
    this.state = rekeyUiTransition(this.state, { type: "continue" });
    this.renderChoose();
    void this.prepareEstimate();
  }

  /** Resume after a reload: verify the current (old) passphrase, then derive
   *  the new keys from the cursor's params. The cursor is the source of the
   *  params: they are the new keys' params in both kinds. */
  private async submitResume(): Promise<void> {
    const values = this.readValues();
    if (!values.current) {
      this.formErrorEl?.setText("Enter your current passphrase.");
      return;
    }
    const saved = this.saved;
    if (!saved) return;
    const s = this.host.settings();
    const salt = b64decode(s.salt);
    const current = await deriveKeys(values.current, salt, {
      opsLimit: s.argon2Params.ops,
      memLimit: s.argon2Params.mem,
    });
    if (s.verifier && !(await checkVerifier(current, b64decode(s.verifier)))) {
      this.formErrorEl?.setText(WRONG_PASSPHRASE);
      return;
    }
    const passphrase = saved.kind === "change" ? values.next : values.current;
    this.newKeys = await deriveKeys(passphrase, salt, { opsLimit: saved.ops, memLimit: saved.mem });
    this.params = { ops: saved.ops, mem: saved.mem };
    this.state = rekeyUiTransition(this.state, { type: "resumed" });
    this.startView(saved.mode);
  }

  // ── Choose phase ──────────────────────────────────────────────────────────

  private renderChoose(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({
      cls: "geode-warn",
      text: this.kind === "change" ? CHANGE_WARNING : REKEY_WARNING,
      attr: { "data-testid": "geode-rekey-warning" },
    });
    this.chooseEl = contentEl.createDiv({ attr: { "data-testid": "geode-rekey-choose" } });
    this.renderChoiceRows();
    this.estimateEl = contentEl.createEl("p", {
      text: ESTIMATING,
      attr: { "data-testid": "geode-rekey-estimate" },
    });
    new Setting(contentEl)
      .setName(this.kind === "change" ? CHECKBOX_CHANGE : CHECKBOX_REKEY)
      .addToggle((t) => {
        t.toggleEl.dataset.testid = "geode-rekey-understood";
        t.setValue(false);
        t.onChange((v) => {
          this.understood = v;
          this.updateStartGate();
        });
      });
    new Setting(contentEl).addButton((b) => {
      this.startBtn = b;
      b.setCta().setButtonText(START_BUTTON);
      b.buttonEl.dataset.testid = "geode-rekey-start";
      b.buttonEl.disabled = true;
      b.onClick(() => {
        if (this.mode) this.start(this.mode);
      });
    });
  }

  private renderChoiceRows(): void {
    const el = this.chooseEl;
    if (!el) return;
    el.empty();
    const copy = this.choice?.copy;
    new Setting(el)
      .setName(COPY_OPTION_NAME)
      .setDesc(copy && !copy.available ? copy.reason ?? COPY_OPTION_DESC : COPY_OPTION_DESC)
      .addToggle((t) => {
        this.copyToggle = t;
        t.toggleEl.dataset.testid = "geode-rekey-copy";
        t.setDisabled(copy ? !copy.available : true);
        t.setValue(false);
        t.onChange((v) => this.setMode(v ? "copy" : null));
      });
    new Setting(el)
      .setName(REPLACE_OPTION_NAME)
      .setDesc(REPLACE_OPTION_DESC)
      .addToggle((t) => {
        this.replaceToggle = t;
        t.toggleEl.dataset.testid = "geode-rekey-replace";
        t.setValue(false);
        t.onChange((v) => this.setMode(v ? "replace" : null));
      });
  }

  private setMode(mode: RekeyMode | null): void {
    this.mode = mode;
    this.copyToggle?.setValue(mode === "copy");
    this.replaceToggle?.setValue(mode === "replace");
    this.updateStartGate();
  }

  private updateStartGate(): void {
    const copyOk = this.mode !== "copy" || this.choice?.copy.available === true;
    this.startBtn?.buttonEl.toggleAttribute("disabled", !(this.mode && this.understood && copyOk));
  }

  /** Work list (bounded concurrency, shared with the run) + network probe +
   *  storage: the honest #558 estimate and the copy space check. Aborted when
   *  the modal closes; failures leave the time unknown and copy blocked. */
  private async prepareEstimate(): Promise<void> {
    const s = this.host.settings();
    const controller = new AbortController();
    this.estimateController = controller;
    const client = makeRekeyClient(
      s.serverUrl,
      s.vaultId,
      s.deviceToken,
      toHex(deriveAuthKey(this.host.keys()!)),
    );
    let vaultBytes = 0;
    let serverFree: number | null = null;
    let work: RekeyWorkList | null = null;
    let probe: NetworkProbe = { rttMs: null, bandwidth: null };
    const started = performance.now();
    log.info("rekey estimate: start", { platform: this.host.isMobile ? "mobile" : "desktop" });
    try {
      const [storage, workList] = await Promise.all([
        logTimed(
          "storage",
          () => getServerStorage(s.serverUrl, s.vaultId, s.deviceToken),
          (st) => ({
            vault_bytes: st.vault_used ?? "unknown",
            free_bytes: st.free,
          }),
        ).catch((e) => {
          log.warn("rekey estimate: storage failed", { error: formatUserError(e) });
          return null;
        }),
        enumerateWork(traceListing(client), { signal: controller.signal }),
      ]);
      // vault_used only: unknown stays unknown (the "Server space unknown"
      // path), never the server-wide used.
      vaultBytes = storage?.vault_used ?? 0;
      serverFree = storage?.free ?? null;
      work = workList;
      probe = await probeNetwork({
        ping: async () => {
          await client.status();
        },
        getBlob: (hash) => client.getBlob(hash),
        sampleBlobHashes: () => probeSample(workList.versions, workList.chunks),
      });
    } catch (e) {
      if (e instanceof RekeyAborted) return;
      // Unreachable server: start stays available (replace) with an unknown time.
      log.warn("rekey estimate failed", { error: formatUserError(e) });
      this.estimateEl?.setText("Time unknown");
    }
    if (controller.signal.aborted) return;
    this.work = work;
    this.vaultBytes = vaultBytes;
    const plan = rekeyPlan({
      vaultBytes,
      chunkCount: work?.chunks.length ?? 0,
      rowBatches: work ? rowBatchesOf(work) : 0,
      isMobile: this.host.isMobile,
      probe,
      serverFree,
    });
    log.info("rekey estimate: done", { wall_ms: Math.round(performance.now() - started) });
    this.estimateEl?.setText(plan.etaText);
    this.choice = plan.choice;
    this.renderChoiceRows();
    this.updateStartGate();
  }

  // ── Handoff to the run view ───────────────────────────────────────────────

  private start(mode: RekeyMode): void {
    if (!this.newKeys || !this.params) return;
    this.state = rekeyUiTransition(this.state, { type: "start", mode });
    this.startView(mode);
    void this.runView?.execute();
  }

  private startView(mode: RekeyMode): void {
    if (!this.newKeys || !this.params) return;
    this.runView = new RekeyRunView(
      this.contentEl,
      this.host,
      {
        kind: this.kind,
        mode,
        newKeys: this.newKeys,
        params: this.params,
        work: this.work,
        vaultBytes: this.vaultBytes,
      },
      this.state,
      () => this.close(),
      () => {
        this.state = initialRekeyUiState(this.kind);
        this.renderForm();
      },
    );
  }
}
