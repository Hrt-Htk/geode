import { App as ObsidianApp, ButtonComponent, Setting } from "obsidian";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import { RenameVaultModal } from "./rename-vault-modal.ts";
import { runWithFeedback } from "./button-feedback.ts";
import { serverHost } from "./server-host.ts";
import { type TabState, tabVisibility, type VaultRowId } from "./tab-state.ts";
import type { SettingsRow } from "./settings-legacy.ts";
import { setDestructive } from "./api-compat.ts";
import { wholeAtLeastOne } from "./settings-tree.ts";
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
  state: () => TabState;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  lockVault: () => void;
  openRekeyModal: (kind: RekeyKind) => void;
  rekeyPaused: () => boolean;
};

const VAULT_LOCK_DESC = "Unlocked. Locking requires the passphrase to sync again.";

export function vaultDisplayName(s: { vaultName: string; vaultId: string }): string {
  return s.vaultName || s.vaultId;
}

/** Vault section rows: vault name/desc + lock row + auto lock; lock state updates in place. */
export class SettingsVaultSection {
  private vaultDescEl: HTMLElement | null = null;
  private vaultRow: Setting | null = null;
  private vaultLockSetting: Setting | null = null;
  private passphraseSetting: Setting | null = null;
  private lockBtn: ButtonComponent | null = null;
  private renameBtn: ButtonComponent | null = null;
  private passphraseBtn: ButtonComponent | null = null;

  constructor(private host: VaultSectionHost) {}

  private shows(row: VaultRowId): () => boolean {
    return () => tabVisibility(this.host.state()).vaultRows.includes(row);
  }

  rows(): SettingsRow[] {
    return [{
      name: "Geode vault",
      render: (s) => {
        s.settingEl.dataset.testid = "geode-settings-vault-name";
        this.vaultRow = s;
        this.vaultDescEl = s.descEl;
        this.renameBtn = null;
        this.updateVaultDesc();
        this.setRenameBtn(this.host.state() !== "locked");
      },
    }, {
      name: "Vault lock",
      visible: this.shows("vault-lock"),
      render: (s) => {
        s.settingEl.dataset.testid = "geode-settings-vault-status";
        this.vaultLockSetting = s;
        this.lockBtn = null;
        this.syncLockRow(this.host.state() === "locked");
      },
    }, {
      name: "Auto lock after (hours)",
      desc: "Locks after this many idle hours.",
      aliases: ["auto-lock", "autolock"],
      visible: this.shows("autolock"),
      control: { type: "number", key: "unlockTimeoutHours", min: 1, validate: wholeAtLeastOne },
    }, {
      // #559: passphrase row; an open rekey cursor shows the paused state.
      name: PASSPHRASE_ROW_NAME,
      visible: this.shows("passphrase"),
      render: (s) => {
        s.settingEl.dataset.testid = "geode-settings-passphrase";
        this.passphraseSetting = s;
        s.addButton((btn) => {
          this.passphraseBtn = btn;
          btn.buttonEl.dataset.testid = "geode-settings-passphrase-change";
          btn.onClick(() => this.host.openRekeyModal("change"));
        });
        this.updatePassphraseRow();
      },
    }];
  }

  private updatePassphraseRow(): void {
    const paused = this.host.rekeyPaused();
    this.passphraseSetting?.setDesc(paused ? RESUME_ROW_DESC : PASSPHRASE_ROW_DESC);
    this.passphraseBtn?.setButtonText(paused ? RESUME_ROW_BUTTON : CHANGE_ROW_BUTTON);
  }

  private syncLockRow(locked: boolean): void {
    const row = this.vaultLockSetting;
    if (!row) return;
    row.setDesc(locked ? "Locked." : VAULT_LOCK_DESC);
    if (!locked) {
      if (!this.lockBtn) {
        row.addButton((btn) => {
          this.lockBtn = btn;
          setDestructive(btn).setButtonText("Lock vault");
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
      this.vaultRow?.addButton((btn) => {
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

  /** Lock-row desc/button and Rename swap in place (#458); the rows that hide follow `visible`. */
  setState(state: TabState): void {
    const locked = state === "locked";
    this.syncLockRow(locked);
    this.setRenameBtn(!locked);
    this.updatePassphraseRow();
  }

  updateVaultDesc(): void {
    if (!this.vaultDescEl) return;
    const s = this.host.settings();
    this.vaultDescEl.setText(`${vaultDisplayName(s)} · ${serverHost(s.serverUrl)}`);
  }
}
