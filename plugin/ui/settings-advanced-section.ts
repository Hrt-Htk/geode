import { App as ObsidianApp, Notice } from "obsidian";
import type { SettingsRow } from "./settings-legacy.ts";
import { setDestructive } from "./api-compat.ts";
import { formatError, log } from "../plumbing/log.ts";
import { httpBase } from "../plumbing/scheme.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import { checkServerVault } from "../plumbing/provisioning-client.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { confirmLeaveVault, confirmResyncFromScratch } from "./confirm-copy.ts";
import { vaultDisplayName } from "./settings-vault-section.ts";
import { ServerAddressModal } from "./server-address-modal.ts";
import { runWithFeedback } from "./button-feedback.ts";
import { STRENGTH_OPTIONS } from "./setup-wizard-logic.ts";
import {
  REKEY_ROW_BUTTON,
  type RekeyKind,
  STRENGTH_CUSTOM,
  STRENGTH_ROW_NAME,
  strengthLevelOf,
} from "./rekey-modal-logic.ts";

export type AdvancedSectionHost = {
  app: ObsidianApp;
  settings: () => PluginSettings;
  saveSettings: () => Promise<void>;
  applyServerAddress: (url: string) => Promise<void>;
  resyncFromScratch: () => Promise<void>;
  leaveVault: () => Promise<void>;
  /** #559: the re-key modal, entered from the Encryption strength row. */
  openRekeyModal: (kind: RekeyKind) => void;
};

/** Advanced section rows: read-only values + check-gated live server-address edit. */
export class SettingsAdvancedSection {
  private advServerValueEl: HTMLElement | null = null;

  constructor(private host: AdvancedSectionHost) {}

  rows(): SettingsRow[] {
    return [
      this.readOnlyRow({
        name: "Server address",
        desc: "Applies to this device only.",
        testid: "geode-settings-adv-server",
        value: () => this.host.settings().serverUrl,
        onEdit: () => this.openServerAddressModal(),
      }),
      this.readOnlyRow({
        name: "Vault ID",
        desc: "Unique ID for this vault.",
        testid: "geode-settings-adv-vault-id",
        value: () => this.host.settings().vaultId,
      }),
      this.readOnlyRow({
        name: "Device Token",
        desc: "Token for this device.",
        testid: "geode-settings-adv-device-token",
        value: () => this.host.settings().deviceToken,
      }),
      this.readOnlyRow({
        name: "Salt (base64)",
        desc: "Encryption salt used for passphrase derivation.",
        testid: "geode-settings-adv-salt",
        value: () => this.host.settings().salt,
      }),
      ...this.configuredRows(),
    ];
  }

  // #424: read-only Advanced row: value + [Edit] or value + [Copy].
  private readOnlyRow(opts: {
    name: string;
    desc: string;
    testid: string;
    value: () => string;
    onEdit?: () => void;
  }): SettingsRow {
    return {
      name: opts.name,
      desc: opts.desc,
      render: (row) => {
        const valueEl = row.controlEl.createEl("code", { text: opts.value() });
        valueEl.dataset.testid = opts.testid;
        if (opts.onEdit) {
          this.advServerValueEl = valueEl;
          row.addButton((b) => {
            b.setButtonText("Edit");
            b.buttonEl.dataset.testid = "geode-settings-adv-server-edit";
            b.onClick(opts.onEdit!);
          });
        } else {
          row.addExtraButton((b) => {
            b.setIcon("copy");
            b.setTooltip("Copy");
            b.extraSettingsEl.dataset.testid = `${opts.testid}-copy`;
            b.onClick(() => this.copyValue(opts.value()));
          });
        }
      },
    };
  }

  private copyValue(value: string): void {
    void navigator.clipboard.writeText(value)
      .then(() => new Notice("Copied to clipboard."))
      .catch(() => new Notice("Copy failed."));
  }

  private openServerAddressModal(): void {
    new ServerAddressModal(this.host.app, {
      currentUrl: httpBase(this.host.settings().serverUrl),
      check: (url) =>
        checkServerVault(url, this.host.settings().vaultId, this.host.settings().deviceToken),
      onSaved: (resolved) => {
        void this.host.applyServerAddress(resolved)
          .then(() => {
            this.advServerValueEl?.setText(resolved);
          })
          .catch((error) => {
            log.error("failed to apply server address", { error: formatError(error) });
          });
      },
    }).open();
  }

  private configuredRows(): SettingsRow[] {
    // #559: current strength level + the re-key entry point.
    const level = strengthLevelOf(this.host.settings().argon2Params);
    return [{
      name: STRENGTH_ROW_NAME,
      desc: level ? STRENGTH_OPTIONS[level] : STRENGTH_CUSTOM,
      render: (row) => {
        row.settingEl.dataset.testid = "geode-settings-encryption-strength";
        row.addButton((btn) => {
          btn.setButtonText(REKEY_ROW_BUTTON);
          btn.buttonEl.dataset.testid = "geode-settings-rekey";
          btn.onClick(() => this.host.openRekeyModal("rekey"));
        });
      },
    }, {
      name: "Debug logging",
      desc: "Log sync activity and show the logs.",
      control: { type: "toggle", key: "debugLogging" },
    }, {
      name: "Resync from scratch",
      desc: "Download the entire vault from the server. Use only when sync is broken.",
      render: (row) => {
        row.addButton((btn) => {
          setDestructive(btn).setButtonText("Resync from scratch");
          btn.buttonEl.dataset.testid = "geode-settings-resync";
          btn.onClick(() => {
            new ConfirmModal(this.host.app, {
              ...confirmResyncFromScratch(),
              onConfirm: () =>
                runWithFeedback(
                  btn,
                  "Resyncing…",
                  "Geode: resync complete",
                  () => this.host.resyncFromScratch(),
                ),
            }).open();
          });
        });
      },
    }, {
      name: "Leave Geode vault",
      desc: "Disconnect this device and clear its local sync state.",
      render: (row) => {
        row.addButton((btn) => {
          setDestructive(btn).setButtonText("Leave Geode vault");
          btn.buttonEl.dataset.testid = "geode-settings-leave";
          btn.onClick(() => {
            new ConfirmModal(this.host.app, {
              ...confirmLeaveVault(vaultDisplayName(this.host.settings())),
              onConfirm: () => this.host.leaveVault(),
            }).open();
          });
        });
      },
    }];
  }
}
