import { App as ObsidianApp, ButtonComponent, Setting } from "obsidian";
import { describeSyncStatus, DOT_CLASS, type SyncStatusInput } from "./sync-status.ts";
import { describeStorage, type StorageState } from "./storage-status.ts";
import { getServerStorage } from "../plumbing/storage-client.ts";
import { PassphraseModal } from "./passphrase-modal.ts";
import { runWithFeedback } from "./button-feedback.ts";
import { createForgotLink } from "./forgot-modal.ts";
import { FORGOT_TITLE } from "./passphrase-copy.ts";
import type { SettingsRow } from "./settings-legacy.ts";
import {
  NOT_SET_UP_SETUP_DESC,
  NOT_SET_UP_SETUP_NAME,
  NOT_SET_UP_STATUS_TEXT,
  type StatusRowId,
  type TabState,
  tabStateOf,
  tabVisibility,
} from "./tab-state.ts";

export type StatusSectionHost = {
  app: ObsidianApp;
  configured: () => boolean;
  getUnlocked: () => boolean;
  getStatusInput: () => SyncStatusInput;
  unlock: (passphrase: string) => Promise<void>;
  openForgotModal: () => void;
  getStorageTarget: () => { serverUrl: string; vaultId: string; deviceToken: string };
  runSetupWizard: () => void;
  reconcileNow: () => Promise<void>;
  pushNow: () => Promise<void>;
  getPausedAt: () => number;
  pause: () => void;
  resume: () => void;
  /** #431: Settings → Sync activity [View] opens the real modal. */
  openActivityModal: () => void;
  /** #432: the sync-status row's [Review] opens the Conflicts modal. */
  openConflictsModal: () => void;
};

/** Status section rows: sync-status row updates in place; never re-renders the tab. */
export class SettingsStatusSection {
  private statusRow: Setting | null = null;
  private dotEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private conflictTextEl: HTMLElement | null = null;
  private unlockBtn: ButtonComponent | null = null;
  private rowActionBtn: ButtonComponent | null = null;
  private storageTextEl: HTMLElement | null = null;
  private storageMeterEl: HTMLElement | null = null;
  private storageState: StorageState = { kind: "loading" };

  constructor(private host: StatusSectionHost) {}

  private state(): TabState {
    return tabStateOf(this.host.configured(), this.host.getUnlocked());
  }

  private shows(row: StatusRowId): () => boolean {
    return () => tabVisibility(this.state()).statusRows.includes(row);
  }

  rows(): SettingsRow[] {
    if (!this.host.configured()) return this.notSetUpRows();
    return [
      { name: "Sync status", render: (s) => this.renderStatusRow(s) },
      {
        // #440: "Forgot your passphrase?" link row, visible only while locked.
        name: FORGOT_TITLE,
        visible: () => this.state() === "locked",
        render: (s) => {
          createForgotLink(s, "geode-settings-forgot", () => this.host.openForgotModal());
        },
      },
      {
        name: "Server storage",
        visible: this.shows("storage"),
        render: (s) => this.renderStorageRow(s),
      },
      ...this.syncActionRows(),
    ];
  }

  /** Not-set-up state (#458): grey-dot status row + Set up row with the wizard CTA. */
  private notSetUpRows(): SettingsRow[] {
    return [{
      name: "Sync status",
      render: (s) => {
        s.settingEl.dataset.testid = "geode-settings-sync-status";
        s.descEl.createSpan({ cls: "geode-sync-dot geode-sync-dot-grey" });
        s.descEl.createSpan({ text: NOT_SET_UP_STATUS_TEXT });
      },
    }, {
      name: NOT_SET_UP_SETUP_NAME,
      desc: NOT_SET_UP_SETUP_DESC,
      render: (s) => {
        s.addButton((btn) => {
          btn.buttonEl.dataset.testid = "geode-settings-run-wizard";
          btn.setCta().setButtonText("Run setup wizard").onClick(() => this.host.runSetupWizard());
        });
      },
    }];
  }

  private renderStatusRow(row: Setting): void {
    row.settingEl.dataset.testid = "geode-settings-sync-status";
    this.statusRow = row;
    this.unlockBtn = null;
    this.rowActionBtn = null;
    this.dotEl = row.descEl.createSpan({ cls: "geode-sync-dot geode-sync-dot-hidden" });
    this.textEl = row.descEl.createSpan();
    this.conflictTextEl = row.descEl.createDiv({ cls: "geode-pause-conflicts geode-hidden" });
    this.syncStatusButton(this.state() === "locked");
    this.updateStatusRow();
  }

  private renderStorageRow(row: Setting): void {
    row.settingEl.dataset.testid = "geode-settings-storage";
    this.storageTextEl = row.descEl.createSpan();
    this.storageMeterEl = row.controlEl.createDiv({ cls: "geode-storage-meter" });
    this.storageMeterEl.createSpan({ cls: "geode-storage-meter-vault" });
    this.storageMeterEl.createSpan({ cls: "geode-storage-meter-other" });
    this.updateStorageRow();
    if (this.host.getUnlocked()) void this.fetchStorage();
  }

  private async fetchStorage(): Promise<void> {
    if (!this.host.getUnlocked()) return;
    const { serverUrl, vaultId, deviceToken } = this.host.getStorageTarget();
    try {
      this.storageState = {
        kind: "data",
        ...(await getServerStorage(serverUrl, vaultId, deviceToken)),
      };
    } catch {
      this.storageState = { kind: "unavailable" };
    }
    this.updateStorageRow();
  }

  /** Re-describe the storage row in place (text + meter), no tab re-render. */
  private updateStorageRow(): void {
    const d = describeStorage(this.storageState);
    const text = this.storageTextEl;
    if (text) {
      text.setText(d.text);
      text.classList.toggle("geode-storage-text-warning", d.level === "warning");
      text.classList.toggle("geode-storage-text-error", d.level === "error");
    }
    const meter = this.storageMeterEl;
    if (!meter) return;
    meter.classList.toggle(
      "geode-storage-meter-hidden",
      d.vaultPct === null && d.otherPct === null,
    );
    meter.classList.toggle("geode-storage-meter-disabled", d.level === "loading");
    meter.classList.toggle("geode-storage-meter-warning", d.level === "warning");
    meter.classList.toggle("geode-storage-meter-error", d.level === "error");
    (meter.firstChild as HTMLElement).style.width = `${d.vaultPct ?? 0}%`;
    (meter.lastChild as HTMLElement).style.width = `${d.otherPct ?? 0}%`;
  }

  private syncActionRows(): SettingsRow[] {
    const visible = this.shows("actions");
    return [{
      name: "Reconcile now",
      desc: "Compare local and remote state and resolve differences.",
      visible,
      render: (s) => {
        s.addButton((btn) => {
          btn.setButtonText("Reconcile now");
          btn.buttonEl.dataset.testid = "geode-settings-reconcile";
          btn.onClick(() => {
            void runWithFeedback(
              btn,
              "Reconciling…",
              "Geode: reconcile complete",
              () => this.host.reconcileNow(),
            );
          });
        });
      },
    }, {
      name: "Push now",
      desc: "Push local changes to the server immediately.",
      visible,
      render: (s) => {
        s.addButton((btn) => {
          btn.setButtonText("Push now");
          btn.buttonEl.dataset.testid = "geode-settings-push";
          btn.onClick(() => {
            void runWithFeedback(
              btn,
              "Pushing…",
              "Geode: push complete",
              () => this.host.pushNow(),
            );
          });
        });
      },
    }, {
      name: "Sync activity",
      desc: "Recent uploads, downloads, conflicts and errors, one line per file.",
      visible,
      render: (s) => {
        s.settingEl.dataset.testid = "geode-settings-activity";
        s.addButton((btn) => {
          btn.setButtonText("View");
          btn.buttonEl.dataset.testid = "geode-settings-activity-view";
          btn.onClick(() => this.host.openActivityModal());
        });
      },
    }];
  }

  /** Swap the sync-status row's [Unlock]/[Pause] control and re-describe it in place (#458);
   * the rows that hide while locked follow their `visible`. */
  setState(state: TabState): void {
    this.syncStatusButton(state === "locked");
    this.updateStatusRow();
    if (state !== "locked") void this.fetchStorage();
  }

  private syncStatusButton(locked: boolean): void {
    const row = this.statusRow;
    if (!row) return;
    if (locked && !this.unlockBtn) {
      this.removePauseBtn();
      row.addButton((btn) => {
        this.unlockBtn = btn;
        btn.setCta().setButtonText("Unlock");
        btn.buttonEl.dataset.testid = "geode-settings-unlock";
        btn.onClick(() => {
          new PassphraseModal(
            this.host.app,
            (p) => this.host.unlock(p),
            () => this.host.openForgotModal(),
          ).open();
        });
      });
    } else if (!locked && this.unlockBtn) {
      this.unlockBtn.buttonEl.remove();
      this.unlockBtn = null;
    }
    if (!locked && !this.rowActionBtn) this.addPauseBtn();
  }

  private addPauseBtn(): void {
    const row = this.statusRow;
    if (!row) return;
    row.addButton((btn) => {
      this.rowActionBtn = btn;
      btn.onClick(() => {
        // #432: while a conflict is open the row's action is [Review]; Pause returns otherwise.
        if (this.host.getStatusInput().conflictCount > 0) this.host.openConflictsModal();
        else if (this.host.getPausedAt() > 0) this.host.resume();
        else this.host.pause();
      });
    });
    this.updatePauseBtn();
  }

  private updatePauseBtn(): void {
    const btn = this.rowActionBtn;
    if (!btn) return;
    const reviewing = this.host.getStatusInput().conflictCount > 0;
    btn.setButtonText(reviewing ? "Review" : this.host.getPausedAt() > 0 ? "Resume" : "Pause");
    btn.buttonEl.dataset.testid = reviewing ? "geode-settings-review" : "geode-settings-pause";
  }

  private removePauseBtn(): void {
    this.rowActionBtn?.buttonEl.remove();
    this.rowActionBtn = null;
  }

  /** Re-describe the sync-status row from live status + last-backup time. */
  updateStatusRow(): void {
    if (!this.dotEl || !this.textEl) return;
    this.updatePauseBtn();
    const { text, dot, conflictText } = describeSyncStatus(this.host.getStatusInput(), Date.now());
    this.textEl.setText(text);
    this.conflictTextEl?.setText(conflictText ?? "");
    this.conflictTextEl?.toggleClass("geode-hidden", !conflictText);
    for (const cls of Object.values(DOT_CLASS)) this.dotEl.classList.remove(cls);
    this.dotEl.classList.toggle("geode-sync-dot-hidden", !dot);
    if (dot) this.dotEl.addClass(DOT_CLASS[dot]);
  }
}
