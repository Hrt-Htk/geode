// #559: the re-key run lifecycle (running/paused/failed/save-failed/done),
// split out of the modal so the shell stays input collection. Pause is an
// AbortSignal; Resume/Retry re-enter runRekey on the cursor; a post-switch
// persist failure is a distinct save-failed state whose Retry re-runs only
// the local persist (the server switch is irreversible).
import { Setting } from "obsidian";
import { deriveAuthKey, type VaultKeys } from "../../core/crypto.ts";
import { toHex } from "../../core/hash.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { makeRekeyClient } from "../plumbing/rekey-client.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import {
  RekeyAborted,
  type RekeyClient,
  type RekeyCursorStore,
  type RekeyKind,
  type RekeyMode,
  type RekeyProgress,
  type RekeyWorkList,
  runRekey,
} from "../sync/rekey-run.ts";
import { liveEta } from "./rekey-estimate.ts";
import {
  CANCEL_BUTTON,
  DONE_BUTTON,
  KEEP_OPEN_LINE,
  PAUSE_BUTTON,
  PAUSED_LINE,
  rekeyProgressLine,
  type RekeyUiState,
  rekeyUiTransition,
  RESUME_BUTTON,
  RETRY_BUTTON,
  RUN_TITLE,
  SAVE_FAILED_LINE,
  SUCCESS_LINES,
  SUCCESS_SUBLINE,
} from "./rekey-modal-logic.ts";

export type RekeyRunViewHost = {
  settings: () => PluginSettings;
  keys: () => VaultKeys | null;
  cursor: () => RekeyCursorStore;
  finishRekey: (
    newKeys: VaultKeys,
    params: { ops: number; mem: number },
    verifierB64: string,
  ) => Promise<void>;
};

export type RekeyRun = {
  kind: RekeyKind;
  mode: RekeyMode;
  newKeys: VaultKeys;
  params: { ops: number; mem: number };
  /** Prebuilt in the choose phase; the worker builds it when absent. */
  work: RekeyWorkList | null;
  vaultBytes: number;
};

export class RekeyRunView {
  private state: RekeyUiState;
  private controller: AbortController | null = null;
  private client: RekeyClient | null = null;
  private progressLine = "";
  private verifierB64: string | null = null;
  private runLineEl: HTMLElement | null = null;
  private runButtonsEl: HTMLElement | null = null;

  constructor(
    private contentEl: HTMLElement,
    private host: RekeyRunViewHost,
    private run: RekeyRun,
    state: RekeyUiState,
    private onClose: () => void,
    private onCancel: () => void,
  ) {
    this.state = state;
    this.render();
  }

  /** Closing the modal stops the worker; the cursor is already persisted. */
  dispose(): void {
    this.controller?.abort();
  }

  /** Run (or re-run after Resume/Retry) until done, failed, paused, or cancelled. */
  async execute(): Promise<void> {
    const mode = this.state.mode!;
    this.client ??= this.makeClient();
    this.controller = new AbortController();
    const startedAt = Date.now();
    try {
      const result = await runRekey({
        kind: this.run.kind,
        oldKeys: this.host.keys()!,
        newKeys: this.run.newKeys,
        params: this.run.params,
        mode,
        client: this.client,
        cursor: this.host.cursor(),
        work: this.run.work ?? undefined,
        signal: this.controller.signal,
        onProgress: (p) => this.onProgress(p, startedAt),
      });
      this.verifierB64 = result.verifierB64;
      this.state = rekeyUiTransition(this.state, { type: "done" });
      try {
        await this.host.finishRekey(this.run.newKeys, this.run.params, result.verifierB64);
      } catch (e) {
        // The server switch is done; only the local persist failed.
        this.state = rekeyUiTransition(this.state, {
          type: "save-failed",
          reason: formatUserError(e),
        });
        this.render();
        return;
      }
      this.render();
    } catch (e) {
      if (this.state.phase === "form") {
        // Cancel already handled the abort: win the worker's cursor save race
        // (file + memory) and stay on the form without re-rendering.
        this.host.cursor().clear();
        return;
      }
      if (e instanceof RekeyAborted) {
        this.state = rekeyUiTransition(this.state, { type: "pause" });
      } else {
        this.state = rekeyUiTransition(this.state, { type: "fail", reason: formatUserError(e) });
      }
      this.render();
    }
  }

  private makeClient(): RekeyClient {
    const s = this.host.settings();
    return makeRekeyClient(
      s.serverUrl,
      s.vaultId,
      s.deviceToken,
      toHex(deriveAuthKey(this.host.keys()!)),
    );
  }

  private onProgress(p: RekeyProgress, startedAt: number): void {
    const eta = p.phase === "blobs" && p.total > 0
      ? liveEta(
        (this.run.vaultBytes * p.done) / p.total,
        this.run.vaultBytes,
        Date.now() - startedAt,
      )
      : null;
    this.progressLine = rekeyProgressLine(p.phase, p.done, p.total, eta);
    this.runLineEl?.setText(this.runLine());
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    if (this.state.phase === "done") {
      el.createEl("p", {
        text: SUCCESS_LINES[this.run.kind],
        attr: { "data-testid": "geode-rekey-success" },
      });
      el.createEl("p", {
        cls: "geode-strength-detail",
        text: SUCCESS_SUBLINE,
        attr: { "data-testid": "geode-rekey-success-sub" },
      });
      this.renderButtons();
      return;
    }
    el.createEl("p", { text: RUN_TITLE, attr: { "data-testid": "geode-rekey-run-title" } });
    this.runLineEl = el.createEl("p", {
      text: this.runLine(),
      attr: { "data-testid": "geode-rekey-progress" },
    });
    if (this.state.phase !== "failed" && this.state.phase !== "save-failed") {
      el.createEl("p", { text: KEEP_OPEN_LINE, attr: { "data-testid": "geode-rekey-keep-open" } });
    }
    this.renderButtons();
  }

  private runLine(): string {
    if (this.state.phase === "failed") return this.state.failReason ?? "";
    if (this.state.phase === "save-failed") {
      return `${SAVE_FAILED_LINE} ${this.state.failReason ?? ""}`;
    }
    if (this.state.phase === "paused") return PAUSED_LINE;
    return this.progressLine;
  }

  private renderButtons(): void {
    this.runButtonsEl = this.contentEl.createDiv({
      attr: { "data-testid": "geode-rekey-run-buttons" },
    });
    const el = this.runButtonsEl;
    const add = (label: string, testid: string, onClick: () => void, cta = false): void => {
      new Setting(el).addButton((b) => {
        if (cta) b.setCta();
        b.setButtonText(label);
        b.buttonEl.dataset.testid = testid;
        b.onClick(onClick);
      });
    };
    if (this.state.phase === "running") {
      add(PAUSE_BUTTON, "geode-rekey-pause", () => this.controller?.abort());
    } else if (this.state.phase === "paused") {
      add(RESUME_BUTTON, "geode-rekey-resume", () => this.resume(), true);
    } else if (this.state.phase === "failed") {
      add(RETRY_BUTTON, "geode-rekey-retry", () => this.retry(), true);
    } else if (this.state.phase === "save-failed") {
      add(RETRY_BUTTON, "geode-rekey-retry-save", () => void this.retrySave(), true);
    } else if (this.state.phase === "done") {
      add(DONE_BUTTON, "geode-rekey-done", () => this.onClose(), true);
    }
    // Replace can't be cancelled (issue #559); the state machine guards too.
    // Cancel is legal only while the run is open: running, paused, failed.
    if (
      this.state.mode === "copy" &&
      (this.state.phase === "running" || this.state.phase === "paused" ||
        this.state.phase === "failed")
    ) {
      add(CANCEL_BUTTON, "geode-rekey-cancel", () => this.cancel());
    }
  }

  private resume(): void {
    this.state = rekeyUiTransition(this.state, { type: "resume" });
    this.runLineEl?.setText(this.runLine());
    void this.execute();
  }

  private retry(): void {
    this.state = rekeyUiTransition(this.state, { type: "retry" });
    this.runLineEl?.setText(this.runLine());
    void this.execute();
  }

  /** Save-failed Retry: re-run only the local persist, never runRekey. */
  private async retrySave(): Promise<void> {
    if (!this.verifierB64) return;
    try {
      await this.host.finishRekey(this.run.newKeys, this.run.params, this.verifierB64);
      this.state = rekeyUiTransition(this.state, { type: "done" });
    } catch (e) {
      this.state = { ...this.state, failReason: formatUserError(e) };
    }
    this.render();
  }

  private cancel(): void {
    this.controller?.abort();
    this.host.cursor().clear();
    void this.client?.cancel().catch(() => {});
    this.state = rekeyUiTransition(this.state, { type: "cancel" });
    this.onCancel();
  }
}
