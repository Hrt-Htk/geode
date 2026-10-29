import { App, Modal, Platform, Setting } from "obsidian";
import type { RejoinBackup } from "../sync/rejoin.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { normalizeServerInput } from "../plumbing/scheme.ts";
import { listVaults, type VaultInfo } from "../plumbing/provisioning-client.ts";
import { generateDeviceName, validateDeviceName } from "./device-name.ts";
import { createForgotLink, openForgotModal } from "./forgot-modal.ts";
import {
  backStep,
  classifyServerError,
  ENCRYPTION_PARAMS,
  type EncryptionLevel,
  mapJoinError,
  rejoinResultText,
  rejoinWarningText,
  serverErrorText,
  STRENGTH_DETAIL,
  STRENGTH_NOTE,
  STRENGTH_OPTIONS,
  validateCreateForm,
  type WizardFlow,
  type WizardStep,
  wizardTitle,
} from "./setup-wizard-logic.ts";

type PluginInstance = {
  app: App;
  createVaultFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultName: string;
    deviceName: string;
    passphrase: string;
    argon2Params?: { ops: number; mem: number };
  }, keepWizardOpen?: boolean): Promise<void>;
  joinWithAdminFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  }, keepWizardOpen?: boolean): Promise<{ rejoin: RejoinBackup | null }>;
  /** #701: the join would land on an old copy of the same vault. */
  detectRejoin(vaultId: string): Promise<boolean>;
  leaveVault: () => Promise<void>;
  startSetupWizard: () => void;
  onWizardClosed?(): void;
};

// One step per screen (#441): Choose → Create server/vault → Done, or
// Choose → Join server/vault → Done. Back on form steps, Enter submits, a
// working label on the CTA while busy. Field values are read from the DOM at
// submit; only cross-screen values live in the values map (server + admin are
// captured when the step advances, so Back can restore them).
export class SetupWizardModal extends Modal {
  private step: WizardStep = "choose";
  private flow: WizardFlow | null = null;
  private cta: HTMLButtonElement | null = null;
  private values = {
    createServer: "",
    createAdmin: "",
    joinServer: "",
    joinAdmin: "",
    joinVaults: [] as VaultInfo[],
    joinVaultId: "",
    strength: "standard" as EncryptionLevel,
  };
  /** #701: where the rejoin set aside the files that differ, for the Done step. */
  private rejoin: RejoinBackup | null = null;

  constructor(app: App, private plugin: PluginInstance) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(wizardTitle(this.flow));
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.plugin.onWizardClosed?.();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(wizardTitle(this.flow));
    switch (this.step) {
      case "choose":
        this.renderChoose();
        break;
      case "create-server":
        this.renderCreateServer();
        break;
      case "create-vault":
        this.renderCreateVault();
        break;
      case "join-server":
        this.renderJoinServer();
        break;
      case "join-vault":
        this.renderJoinVault();
        break;
      case "done":
        this.renderDone();
        break;
    }
  }

  private renderChoose(): void {
    const { contentEl } = this;
    new Setting(contentEl)
      .setDesc("Your notes are encrypted before they leave this device.");

    new Setting(contentEl)
      .setName("Create a new vault")
      .setDesc("First device, or a new vault on your server.")
      .addButton((b) => {
        b.setCta().setButtonText("Create a new vault");
        b.buttonEl.dataset.testid = "geode-wizard-create";
        b.onClick(() => {
          this.flow = "create";
          this.step = "create-server";
          this.render();
        });
      });

    new Setting(contentEl)
      .setName("Join an existing vault")
      .setDesc("Add this device to a vault you already use.")
      .addButton((b) => {
        b.setCta().setButtonText("Join an existing vault");
        b.buttonEl.dataset.testid = "geode-wizard-join";
        b.onClick(() => {
          this.flow = "join";
          this.step = "join-server";
          this.render();
        });
      });
  }

  private renderCreateServer(): void {
    const { contentEl } = this;
    const serverEl = this.addInput(
      contentEl,
      "Server address",
      "text",
      "localhost:8080 or geode.example.com",
      "geode-create-server",
    );
    const adminEl = this.addInput(
      contentEl,
      "Admin token",
      "password",
      undefined,
      "geode-create-admin",
      "The token you created when you installed the server.",
    );
    serverEl.value = this.values.createServer;
    adminEl.value = this.values.createAdmin;
    const errorEl = this.errorEl(contentEl, "geode-create-error");
    this.buttons(contentEl, "Continue", "geode-create-continue", async () => {
      errorEl.empty();
      const server = serverEl.value.trim();
      const admin = adminEl.value;
      if (!server || !admin) {
        errorEl.setText("Enter a server address and admin token.");
        return;
      }
      this.values.createServer = server;
      this.values.createAdmin = admin;
      this.busy("Checking…");
      try {
        await listVaults(normalizeServerInput(server), admin);
        this.idle("Continue");
        this.step = "create-vault";
        this.render();
      } catch (error) {
        this.idle("Continue");
        errorEl.setText(serverErrorText(classifyServerError(error), normalizeServerInput(server)));
      }
    });
  }

  private renderCreateVault(): void {
    const { contentEl } = this;
    const vaultNameEl = this.addInput(
      contentEl,
      "Vault name",
      "text",
      undefined,
      "geode-create-vault-name",
    );
    const deviceNameEl = this.addInput(
      contentEl,
      "Device name",
      "text",
      undefined,
      "geode-create-device-name",
    );
    deviceNameEl.value = generateDeviceName(Platform.isMobile);
    const passEl = this.addInput(
      contentEl,
      "Passphrase",
      "password",
      undefined,
      "geode-create-passphrase",
      "It can't be recovered, even from your server.",
    );
    const confirmEl = this.addInput(
      contentEl,
      "Confirm passphrase",
      "password",
      undefined,
      "geode-create-confirm",
    );

    this.strengthField(contentEl);

    const errorEl = this.errorEl(contentEl, "geode-create-error");
    this.buttons(contentEl, "Create vault", "geode-create-submit", async () => {
      errorEl.empty();
      const formError = validateCreateForm({
        vaultName: vaultNameEl.value,
        passphrase: passEl.value,
        confirm: confirmEl.value,
      });
      if (formError) {
        errorEl.setText(formError);
        return;
      }
      const device = validateDeviceName(deviceNameEl.value);
      if (!device.ok) {
        errorEl.setText(device.error);
        return;
      }
      this.busy("Creating…");
      try {
        await this.plugin.createVaultFlow(
          {
            serverUrl: this.values.createServer,
            adminToken: this.values.createAdmin,
            vaultName: vaultNameEl.value.trim(),
            deviceName: device.name,
            passphrase: passEl.value,
            argon2Params: ENCRYPTION_PARAMS[this.values.strength],
          },
          true,
        );
        this.idle("Create vault");
        this.step = "done";
        this.render();
      } catch (error) {
        this.idle("Create vault");
        errorEl.setText(formatUserError(error));
      }
    });
  }

  private renderJoinServer(): void {
    const { contentEl } = this;
    const serverEl = this.addInput(
      contentEl,
      "Server address",
      "text",
      "localhost:8080 or geode.example.com",
      "geode-join-server",
    );
    const adminEl = this.addInput(
      contentEl,
      "Admin token",
      "password",
      undefined,
      "geode-join-admin",
      "The token you created when you installed the server.",
    );
    serverEl.value = this.values.joinServer;
    adminEl.value = this.values.joinAdmin;
    const errorEl = this.errorEl(contentEl, "geode-join-error");
    this.buttons(contentEl, "Load vaults", "geode-join-load", async () => {
      errorEl.empty();
      const server = serverEl.value.trim();
      const admin = adminEl.value;
      if (!server || !admin) {
        errorEl.setText("Enter a server address and admin token.");
        return;
      }
      this.values.joinServer = server;
      this.values.joinAdmin = admin;
      this.busy("Loading…");
      try {
        const vaults = await listVaults(normalizeServerInput(server), admin);
        this.idle("Load vaults");
        if (vaults.length === 0) {
          errorEl.setText("No vaults found on this server.");
          return;
        }
        this.values.joinVaults = vaults;
        this.values.joinVaultId = vaults[0].id;
        this.step = "join-vault";
        this.render();
      } catch (error) {
        this.idle("Load vaults");
        errorEl.setText(serverErrorText(classifyServerError(error), normalizeServerInput(server)));
      }
    });
  }

  private renderJoinVault(): void {
    const { contentEl } = this;
    // #701: the folder already holds a copy of this vault: say what the join will do
    // before it runs. The detection is async, so the line fills in; until it says yes the
    // paragraph takes no space (a first join shows nothing).
    const warningEl = contentEl.createEl("p", {
      cls: "geode-warn",
      attr: { "data-testid": "geode-join-rejoin-warning" },
    });
    warningEl.style.display = "none";
    new Setting(contentEl)
      .setName("Geode vault")
      .addDropdown((d) => {
        for (const v of this.values.joinVaults) {
          d.addOption(v.id, `${v.name} (${v.device_count} devices)`);
        }
        d.selectEl.dataset.testid = "geode-join-vault-select";
        d.setValue(this.values.joinVaultId);
        d.onChange((val) => {
          this.values.joinVaultId = val;
          this.showRejoinWarning(warningEl);
        });
      });
    this.showRejoinWarning(warningEl);
    const deviceNameEl = this.addInput(
      contentEl,
      "Device name",
      "text",
      undefined,
      "geode-join-device-name",
    );
    deviceNameEl.value = generateDeviceName(Platform.isMobile);
    const passEl = this.addInput(
      contentEl,
      "Passphrase",
      "password",
      undefined,
      "geode-join-passphrase",
    );
    // #440: forgot link on the Join passphrase step; the wizard is the entry
    // point, so no "try again" target.
    createForgotLink(contentEl, "geode-join-forgot", () => openForgotModal(this.plugin));
    const errorEl = this.errorEl(contentEl, "geode-join-error");
    this.buttons(contentEl, "Join", "geode-join-submit", async () => {
      errorEl.empty();
      const device = validateDeviceName(deviceNameEl.value);
      if (!device.ok) {
        errorEl.setText(device.error);
        return;
      }
      this.busy("Joining…");
      try {
        const { rejoin } = await this.plugin.joinWithAdminFlow(
          {
            serverUrl: this.values.joinServer,
            adminToken: this.values.joinAdmin,
            vaultId: this.values.joinVaultId,
            deviceName: device.name,
            passphrase: passEl.value,
          },
          true,
        );
        this.rejoin = rejoin;
        this.idle("Join");
        this.step = "done";
        this.render();
      } catch (error) {
        this.idle("Join");
        errorEl.setText(mapJoinError(error, normalizeServerInput(this.values.joinServer)));
      }
    });
  }

  /** #701: warn before the join proceeds, and stay quiet on every other join. */
  private showRejoinWarning(el: HTMLElement): void {
    const vaultId = this.values.joinVaultId;
    const apply = (rejoin: boolean): void => {
      if (this.values.joinVaultId !== vaultId) return; // the user picked another vault
      el.setText(rejoin ? rejoinWarningText() : "");
      el.style.display = rejoin ? "" : "none";
    };
    void this.plugin.detectRejoin(vaultId).then(apply).catch(() => apply(false));
  }

  private renderDone(): void {
    const { contentEl } = this;
    new Setting(contentEl)
      .setDesc("Connected. Your vault is syncing.");
    if (this.rejoin) {
      contentEl.createEl("p", {
        cls: "geode-rejoin-result",
        attr: { "data-testid": "geode-join-rejoin-result" },
        text: rejoinResultText(this.rejoin.count, this.rejoin.folder),
      });
    }
    new Setting(contentEl).addButton((b) => {
      b.setCta().setButtonText("Done");
      b.buttonEl.dataset.testid = "geode-done-submit";
      b.onClick(() => this.close());
    });
  }

  private strengthField(container: HTMLElement): void {
    let detailEl: HTMLElement | null = null;
    new Setting(container)
      .setName("Encryption strength")
      .setDesc(STRENGTH_NOTE)
      .addDropdown((d) => {
        for (const level of Object.keys(STRENGTH_OPTIONS) as EncryptionLevel[]) {
          d.addOption(level, STRENGTH_OPTIONS[level]);
        }
        d.selectEl.dataset.testid = "geode-create-strength";
        d.setValue(this.values.strength);
        d.onChange((v) => {
          this.values.strength = v as EncryptionLevel;
          if (detailEl) detailEl.setText(STRENGTH_DETAIL[this.values.strength]);
        });
      });
    detailEl = container.createEl("p", {
      cls: "geode-strength-detail",
      text: STRENGTH_DETAIL[this.values.strength],
    });
  }

  private addInput(
    container: HTMLElement,
    label: string,
    type: string,
    placeholder?: string,
    testid?: string,
    desc?: string,
  ): HTMLInputElement {
    let inputEl: HTMLInputElement | null = null;
    const setting = new Setting(container).setName(label);
    if (desc) setting.setDesc(desc);
    setting.addText((t) => {
      inputEl = t.inputEl;
      t.inputEl.type = type;
      if (placeholder) t.setPlaceholder(placeholder);
      if (testid) t.inputEl.dataset.testid = testid;
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") this.cta?.click();
      });
    });
    return inputEl!;
  }

  private errorEl(container: HTMLElement, testid: string): HTMLParagraphElement {
    return container.createEl("p", {
      cls: "geode-error",
      attr: { "data-testid": testid },
    });
  }

  private buttons(
    container: HTMLElement,
    label: string,
    testid: string,
    onClick: () => Promise<void>,
  ): void {
    const row = new Setting(container);
    const back = backStep(this.step);
    if (back) {
      row.addButton((b) => {
        b.setButtonText("Back");
        b.buttonEl.dataset.testid = "geode-wizard-back";
        b.onClick(() => {
          this.step = back;
          this.render();
        });
      });
    }
    row.addButton((b) => {
      b.setCta().setButtonText(label);
      b.buttonEl.dataset.testid = testid;
      this.cta = b.buttonEl;
      b.onClick(async () => {
        await onClick();
      });
    });
  }

  private busy(working: string): void {
    if (!this.cta) return;
    this.cta.textContent = working;
    this.cta.disabled = true;
  }

  private idle(label: string): void {
    if (!this.cta) return;
    this.cta.textContent = label;
    this.cta.disabled = false;
  }
}
