import { App as ObsidianApp, ButtonComponent, Setting } from "obsidian";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import { RenameVaultModal } from "./rename-vault-modal.ts";
import { runWithFeedback } from "./button-feedback.ts";
import { serverHost } from "./server-host.ts";
import { type TabState, tabVisibility } from "./tab-state.ts";
import {
  CHANGE_ROW_BUTTON,
  PASSPHRASE_ROW_DESC,
  PASSPHRASE_ROW_NAME,
  type RekeyKind,
  RESUME_ROW_BUTTON,
  RESUME_ROW_DESC,
} from "./rekey-modal-logic.ts";

export type VaultSectionHost = {
  app: ObsidianApp;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  getUnlocked: () => boolean;
  lockVault: () => void;
  openRekeyModal: (kind: RekeyKind) => void;
  rekeyPaused: () => boolean;
};

const VAULT_LOCK_DESC = "Unlocked. Locking requires the passphrase to sync again.";

export function vaultDisplayName(s: { vaultName: string; vaultId: string }): string {
  return s.vaultName || s.vaultId;
}

/** Vault section rows: vault name/desc + lock row + auto-lock; lock state updates in place. */
export class SettingsVaultSection {
  private vaultDescEl: HTMLElement | null = null;
  private vaultRow!: Setting;
  private vaultLockSetting!: Setting;
  private autolockSetting!: Setting;
  private passphraseSetting!: Setting;
  private lockBtn: ButtonComponent | null = null;
  private renameBtn: ButtonComponent | null = null;
  private passphraseBtn: ButtonComponent | null = null;

  constructor(private fields: HTMLElement, private host: VaultSectionHost) {
    this.render();
  }

  private render(): void {
    const vaultRow = new Setting(this.fields).setName("Geode vault");
    vaultRow.settingEl.dataset.testid = "geode-settings-vault-name";
    this.vaultRow = vaultRow;
    this.vaultDescEl = vaultRow.descEl;
    this.updateVaultDesc();
    this.setRenameBtn(true);

    this.vaultLockSetting = new Setting(this.fields).setName("Vault lock");
    this.vaultLockSetting.settingEl.dataset.testid = "geode-settings-vault-status";
    this.setLockBtn(!this.host.getUnlocked());

    this.autolockSetting = new Setting(this.fields)
      .setName("Auto-lock after (hours)")
      .setDesc("Locks after this many idle hours.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "1";
        t.inputEl.dataset.testid = "geode-settings-autolock";
        t.inputEl.value = String(this.host.settings().unlockTimeoutHours);
        t.inputEl.addEventListener("change", () => {
          const v = parseInt(t.inputEl.value, 10);
          if (!isNaN(v) && v > 0) {
            this.host.settings().unlockTimeoutHours = v;
            void this.host.saveSettings();
          }
        });
      });

    // #559: passphrase row; an open rekey cursor shows the paused state.
    this.passphraseSetting = new Setting(this.fields).setName(PASSPHRASE_ROW_NAME);
    this.passphraseSetting.settingEl.dataset.testid = "geode-settings-passphrase";
    this.passphraseSetting.addButton((btn) => {
      this.passphraseBtn = btn;
      btn.buttonEl.dataset.testid = "geode-settings-passphrase-change";
      btn.onClick(() => this.host.openRekeyModal("change"));
    });
    this.updatePassphraseRow();
  }

  private updatePassphraseRow(): void {
    const paused = this.host.rekeyPaused();
    this.passphraseSetting.setDesc(paused ? RESUME_ROW_DESC : PASSPHRASE_ROW_DESC);
    this.passphraseBtn?.setButtonText(paused ? RESUME_ROW_BUTTON : CHANGE_ROW_BUTTON);
  }

  private setLockBtn(locked: boolean): void {
    if (!locked) {
      if (!this.lockBtn) {
        this.vaultLockSetting.addButton((btn) => {
          this.lockBtn = btn;
          btn.setWarning().setButtonText("Lock vault");
          btn.buttonEl.dataset.testid = "geode-settings-lock";
          btn.onClick(() => {
            void runWithFeedback(
              btn,
              "Locking…",
              "Geode: vault locked",
              () => this.host.lockVault(),
            );
          });
        });
      }
    } else {
      this.lockBtn?.buttonEl.remove();
      this.lockBtn = null;
    }
  }

  private setRenameBtn(show: boolean): void {
    if (show && !this.renameBtn) {
      const s = this.host.settings();
      this.vaultRow.addButton((btn) => {
        this.renameBtn = btn;
        btn.setButtonText("Rename");
        btn.buttonEl.dataset.testid = "geode-settings-vault-rename";
        btn.onClick(() => {
          new RenameVaultModal(this.host.app, {
            serverUrl: s.serverUrl,
            vaultId: s.vaultId,
            deviceToken: s.deviceToken,
            currentName: vaultDisplayName(s),
            onRenamed: (name) => {
              this.host.settings().vaultName = name;
              void this.host.saveSettings();
              this.updateVaultDesc();
            },
          }).open();
        });
      });
    } else if (!show && this.renameBtn) {
      this.renameBtn.buttonEl.remove();
      this.renameBtn = null;
    }
  }

  /** Hide vault-lock/auto-lock rows + Rename while locked; lock-row desc/button swap: all in place (#458). */
  setState(state: TabState): void {
    const locked = state === "locked";
    this.vaultLockSetting.setDesc(locked ? "Locked." : VAULT_LOCK_DESC);
    this.setLockBtn(locked);
    const { vaultRows } = tabVisibility(state);
    this.vaultLockSetting.settingEl.classList.toggle(
      "geode-hidden",
      !vaultRows.includes("vault-lock"),
    );
    this.autolockSetting.settingEl.classList.toggle(
      "geode-hidden",
      !vaultRows.includes("autolock"),
    );
    this.passphraseSetting.settingEl.classList.toggle(
      "geode-hidden",
      !vaultRows.includes("passphrase"),
    );
    this.setRenameBtn(!locked);
    this.updatePassphraseRow();
  }

  updateVaultDesc(): void {
    if (!this.vaultDescEl) return;
    const s = this.host.settings();
    this.vaultDescEl.setText(`${vaultDisplayName(s)} · ${serverHost(s.serverUrl)}`);
  }
}
