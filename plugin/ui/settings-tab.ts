import {
  App as ObsidianApp,
  ButtonComponent,
  Plugin,
  PluginSettingTab,
  setIcon,
  Setting,
} from "obsidian";
import { isConfigured, type PluginSettings } from "../plumbing/settings-types.ts";
import type { LogEntry } from "../plumbing/log.ts";
import { openForgotModal } from "./forgot-modal.ts";
import { renderSettingsDevicesSection } from "./settings-devices-section.ts";
import { relativeTime } from "./trash-format.ts";
import { filesMissing } from "./mass-delete-review.ts";
import { BannerRow } from "./banner-row.ts";
import { renderTrashSettings } from "./trash-settings.ts";
import type { TrashApi } from "../plumbing/trash-client.ts";
import type { RejoinBackup } from "../sync/rejoin.ts";
import { blockedCopy, describeVersionHint, type VersionStatus } from "../sync/version-state.ts";
import { type CollapsibleSection, createCollapsibleSection } from "./collapsible-section.ts";
import { SettingsLogsSection } from "./settings-logs-section.ts";
import { SettingsStatusSection } from "./settings-status-section.ts";
import { SettingsVaultSection } from "./settings-vault-section.ts";
import { SettingsScopeSection } from "./settings-scope-section.ts";
import { SettingsAdvancedSection } from "./settings-advanced-section.ts";
import { describeErrorBanner } from "./sync-banner.ts";
import type { SyncStatusInput } from "./sync-status.ts";
import { describePauseBanner } from "./pause.ts";
import type { StatusBar } from "./statusbar.ts";
import { type TabState, tabStateOf, tabVisibility } from "./tab-state.ts";
import type { RekeyKind } from "./rekey-modal-logic.ts";

type PluginInstance = {
  app: ObsidianApp;
  pluginSettings: PluginSettings;
  saveSettings: () => Promise<void>;
  reconcileNow: () => Promise<void>;
  pushNow: () => Promise<void>;
  setSyncObsidianConfig: (value: boolean) => void;
  catchUpFolders: (folders: string[]) => Promise<void>;
  resyncFromScratch: () => Promise<void>;
  exportDecryptedVault: (targetDir: string) => Promise<void>;
  lockVault: () => void;
  leaveVault: () => Promise<void>;
  unlockVault: (passphrase: string) => Promise<void>;
  openPassphraseModal: () => void;
  startSetupWizard: () => void;
  isUnlocked: boolean | (() => boolean);
  openTrashModal: () => void;
  /** #601: the held mass-delete row's Review opens the review window. */
  openMassDeleteReview: () => void;
  trash: TrashApi;
  retrySync: (btn: ButtonComponent) => Promise<void>;
  applyServerAddress: (url: string) => Promise<void>;
  adminToken: string | null;
  /** #560: re-key state flags for the status row copy. */
  rekeyElsewhere: boolean;
  rekeyInProgress: boolean;
  versionStatus: VersionStatus;
  lastBackupAt: number;
  getPausedAt: () => number;
  pauseSync: () => Promise<void>;
  resumeSync: () => Promise<void>;
  openActivityModal: () => void;
  openConflictsModal: () => void;
  /** #559: change-passphrase / re-key modal + the paused-cursor row state. */
  openRekeyModal: (kind: RekeyKind) => void;
  rekeyPaused: () => boolean;
  getTransportState: () => string;
  /** #522: the status input the settings row and the activity footer both describe. */
  getStatusInput: () => SyncStatusInput;
  getLastSeenSeq: () => number;
  getPendingCount: () => number;
  getRecentLog: () => LogEntry[];
  exportLog: () => string;
  createVaultFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultName: string;
    deviceName: string;
    passphrase: string;
  }): Promise<void>;
  joinWithAdminFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  }): Promise<{ rejoin: RejoinBackup | null }>;
} & Plugin;

export class GeodeSettingTab extends PluginSettingTab {
  // Section collapsed state for this session (Advanced + Logs start collapsed).
  private collapsed = new Set(["advanced", "logs"]);
  private statusSection: SettingsStatusSection | null = null;
  private vaultSection: SettingsVaultSection | null = null;
  private bannerContainerEl: HTMLElement | null = null;
  private banners: {
    hold: BannerRow;
    error: BannerRow;
    pause: BannerRow;
  } | null = null;
  private versionBanner: Setting | null = null;
  private devicesSection: HTMLElement | null = null;
  private devicesSectionDispose: (() => void) | null = null;
  private scopeSection: HTMLElement | null = null;
  private trashSection: HTMLElement | null = null;
  private advancedSection: HTMLElement | null = null;
  private logsSection: CollapsibleSection | null = null;
  private logsSectionView: SettingsLogsSection | null = null;
  private trashRefresh: (() => void) | null = null;
  private trashHoldRefresh: (() => void) | null = null;
  // Scroll position to restore when the vault unlocks again within this tab session.
  private savedScrollTop = 0;
  private lastState: TabState | null = null;

  constructor(app: ObsidianApp, private plugin: PluginInstance, private statusBar: StatusBar) {
    super(app, plugin);
    this.statusBar.subscribe(() => {
      this.statusSection?.updateStatusRow();
      this.logsSectionView?.refreshDetails();
      this.updateHoldBanner();
      this.updateErrorBanner();
      this.updatePauseBanner();
      this.trashHoldRefresh?.();
    });
  }

  private getUnlocked(): boolean {
    return typeof this.plugin.isUnlocked === "function"
      ? this.plugin.isUnlocked()
      : this.plugin.isUnlocked;
  }

  private section(id: string, name: string): CollapsibleSection {
    return createCollapsibleSection(this.containerEl, name, {
      open: !this.collapsed.has(id),
      onToggle: (open) => {
        if (open) this.collapsed.delete(id);
        else this.collapsed.add(id);
      },
    });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.resetSectionRefs();
    this.savedScrollTop = 0;
    this.lastState = null;

    const state = tabStateOf(isConfigured(this.plugin.pluginSettings), this.getUnlocked());

    if (state !== "notset") {
      this.bannerContainerEl = containerEl.createDiv();
      this.createBanners();
      this.updateBanners();
    }

    this.statusSection = new SettingsStatusSection(this.section("status", "Status").fieldsEl, {
      app: this.app,
      configured: () => isConfigured(this.plugin.pluginSettings),
      getUnlocked: () => this.getUnlocked(),
      getStatusInput: () => this.plugin.getStatusInput(),
      unlock: (p) => this.plugin.unlockVault(p),
      openForgotModal: () => openForgotModal(this.plugin, () => this.plugin.openPassphraseModal()),
      getStorageTarget: () => ({
        serverUrl: this.plugin.pluginSettings.serverUrl,
        vaultId: this.plugin.pluginSettings.vaultId,
        deviceToken: this.plugin.pluginSettings.deviceToken,
      }),
      runSetupWizard: () => this.plugin.startSetupWizard(),
      reconcileNow: () => this.plugin.reconcileNow(),
      pushNow: () => this.plugin.pushNow(),
      getPausedAt: () => this.plugin.getPausedAt(),
      pause: () => void this.plugin.pauseSync(),
      resume: () => void this.plugin.resumeSync(),
      openActivityModal: () => this.plugin.openActivityModal(),
      openConflictsModal: () => this.plugin.openConflictsModal(),
    });

    if (state === "notset") return;

    this.renderConfiguredSections();
    this.applyLockState();
  }

  private resetSectionRefs(): void {
    this.logsSectionView?.destroy();
    this.logsSectionView = null;
    this.logsSection = null;
    this.devicesSectionDispose?.();
    this.devicesSectionDispose = null;
    this.statusSection = null;
    this.vaultSection = null;
    this.devicesSection = null;
    this.scopeSection = null;
    this.trashSection = null;
    this.trashRefresh = null;
    this.trashHoldRefresh = null;
    this.banners = null;
    this.versionBanner = null;
    this.bannerContainerEl = null;
  }

  /** Configured-state sections (vault/devices/scope/trash/advanced): hidden whole by applyLockState while locked. */
  private renderConfiguredSections(): void {
    this.vaultSection = new SettingsVaultSection(this.section("vault", "Vault").fieldsEl, {
      app: this.app,
      settings: () => this.plugin.pluginSettings,
      saveSettings: () => this.plugin.saveSettings(),
      getUnlocked: () => this.getUnlocked(),
      lockVault: () => this.plugin.lockVault(),
      openRekeyModal: (kind) => this.plugin.openRekeyModal(kind),
      rekeyPaused: () => this.plugin.rekeyPaused(),
    });
    const devices = this.section("devices", "Devices");
    this.devicesSection = devices.sectionEl;
    this.devicesSectionDispose = renderSettingsDevicesSection(devices.fieldsEl, {
      app: this.app,
      serverUrl: this.plugin.pluginSettings.serverUrl,
      vaultId: this.plugin.pluginSettings.vaultId,
      currentDeviceId: this.plugin.pluginSettings.deviceId,
      deviceToken: this.plugin.pluginSettings.deviceToken,
      adminToken: this.plugin.adminToken,
      setAdminToken: (token) => {
        this.plugin.adminToken = token;
      },
      onRename: (name) => {
        this.plugin.pluginSettings.deviceName = name;
        void this.plugin.saveSettings();
      },
      relativeTime,
      registerInterval: (id) => this.plugin.registerInterval(id),
    }).dispose;
    const scope = this.section("scope", "Sync scope");
    this.scopeSection = scope.sectionEl;
    new SettingsScopeSection(scope.fieldsEl, {
      app: this.app,
      settings: () => this.plugin.pluginSettings,
      selfPluginId: this.plugin.manifest.id,
      configDir: this.app.vault.configDir,
      saveSettings: () => this.plugin.saveSettings(),
      setSyncObsidianConfig: (v) => this.plugin.setSyncObsidianConfig(v),
      reconcileNow: () => this.plugin.reconcileNow(),
      catchUpFolders: (folders) => this.plugin.catchUpFolders(folders),
    });
    const trash = this.section("trash", "Trash");
    this.trashSection = trash.sectionEl;
    const trashSettings = renderTrashSettings(trash.fieldsEl, {
      settings: this.plugin.pluginSettings,
      saveSettings: () => void this.plugin.saveSettings(),
      openTrashModal: () => this.plugin.openTrashModal(),
      openMassDeleteReview: () => this.plugin.openMassDeleteReview(),
      getHold: () => this.plugin.pluginSettings.massDeleteHold,
      getUnlocked: () => this.getUnlocked(),
      trash: this.plugin.trash,
    });
    this.trashRefresh = trashSettings.refreshCount;
    this.trashHoldRefresh = trashSettings.syncHold;
    const advanced = this.section("advanced", "Advanced");
    advanced.headingEl.addClass("geode-advanced-heading");
    advanced.fieldsEl.addClass("geode-advanced-fields");
    this.advancedSection = advanced.sectionEl;
    this.renderAdvancedSection(advanced.fieldsEl);
    if (this.plugin.pluginSettings.debugLogging) this.renderLogsSection();
  }

  private renderAdvancedSection(fields: HTMLElement): void {
    new SettingsAdvancedSection(fields, {
      app: this.app,
      settings: () => this.plugin.pluginSettings,
      saveSettings: () => this.plugin.saveSettings(),
      applyServerAddress: (url) => this.plugin.applyServerAddress(url),
      resyncFromScratch: () => this.plugin.resyncFromScratch(),
      leaveVault: () => this.plugin.leaveVault(),
      onDebugLoggingChange: (v) => {
        if (v) this.renderLogsSection();
        else this.removeLogsSection();
      },
      openRekeyModal: (kind) => this.plugin.openRekeyModal(kind),
    });
  }

  /** #453/#434: the Logs section, after Advanced and only while Debug logging is on. */
  private renderLogsSection(): void {
    if (this.logsSection) return;
    const section = this.section("logs", "Logs");
    this.logsSection = section;
    this.logsSectionView = new SettingsLogsSection(section.fieldsEl, {
      getTransportState: () => this.plugin.getTransportState(),
      getLastSeenSeq: () => this.plugin.getLastSeenSeq(),
      getPendingCount: () => this.plugin.getPendingCount(),
      getRecentLog: () => this.plugin.getRecentLog(),
      exportLog: () => this.plugin.exportLog(),
    });
  }

  /** Toggling Debug logging off removes the section in place (#453). */
  private removeLogsSection(): void {
    this.logsSectionView?.destroy();
    this.logsSectionView = null;
    this.logsSection?.sectionEl.remove();
    this.logsSection = null;
  }

  /** Closing the settings tab drops the Logs section so it never writes into a
   * detached DOM and stops the Devices poll (#502); display() re-renders both. */
  hide(): void {
    this.removeLogsSection();
    this.devicesSectionDispose?.();
    this.devicesSectionDispose = null;
    super.hide();
  }

  /** In-place state update: swap rows/buttons and hide whole sections (#458, #134); scrollTop survives lock (save/restore, #458). */
  applyLockState(): void {
    const state = tabStateOf(isConfigured(this.plugin.pluginSettings), this.getUnlocked());
    const prev = this.lastState;
    this.lastState = state;
    if (state === "locked" && prev !== "locked") this.savedScrollTop = this.containerEl.scrollTop;
    this.statusSection?.setState(state);
    this.vaultSection?.setState(state);
    const { sections } = tabVisibility(state);
    this.setSectionHidden(this.devicesSection, !sections.includes("devices"));
    this.setSectionHidden(this.scopeSection, !sections.includes("scope"));
    this.setSectionHidden(this.trashSection, !sections.includes("trash"));
    this.setSectionHidden(this.advancedSection, !sections.includes("advanced"));
    this.setSectionHidden(this.logsSection?.sectionEl ?? null, !sections.includes("advanced"));
    if (state === "unlocked" && prev === "locked") this.containerEl.scrollTop = this.savedScrollTop;
    this.updateHoldBanner();
    this.updatePauseBanner();
    this.trashHoldRefresh?.();
    this.trashRefresh?.();
  }

  /** #446: the TrashModal calls this after any trash change so the settings live count stays in sync. */
  refreshTrashCount(): void {
    this.trashRefresh?.();
  }

  private setSectionHidden(section: HTMLElement | null, hidden: boolean): void {
    if (!section) return;
    section.classList.toggle("geode-hidden", hidden);
  }

  /** The version banner is the only one with a changing icon and no action. A refusal is a
   * hard stop, so it sits above every state row; an update hint is advisory and sits below
   * them (the hold is the actionable row there). */
  private createVersionBanner(): void {
    this.versionBanner?.settingEl.remove();
    this.versionBanner = null;
    if (!this.bannerContainerEl) return;
    const vs = this.plugin.versionStatus;
    if (vs.kind === "ok") return;
    const blocked = vs.kind === "blocked";
    const copy = blocked ? blockedCopy(vs.side) : null;
    const setting = new Setting(this.bannerContainerEl)
      .setName(blocked ? copy!.title : "Update available")
      .setDesc(blocked ? copy!.bannerDesc : describeVersionHint(vs.own, vs.server) ?? "");
    this.placeBanner(setting.settingEl, blocked ? 0 : 4);
    const iconSpan = setting.nameEl.createSpan({ cls: "geode-version-warning-icon" });
    if (blocked) iconSpan.addClass("mod-error");
    setIcon(iconSpan, blocked ? "triangle-alert" : "info");
    this.versionBanner = setting;
  }

  /** Insert a banner at its fixed slot (a refusal is 0, the state rows 1-3, a hint 4). */
  private placeBanner(el: HTMLElement, order: number): void {
    el.dataset.bannerOrder = String(order);
    const next = [...this.bannerContainerEl!.children].find(
      (child) => Number((child as HTMLElement).dataset.bannerOrder ?? Infinity) > order,
    );
    this.bannerContainerEl!.insertBefore(el, next ?? null);
  }

  private createBanners(): void {
    const host = this.bannerContainerEl!;
    this.banners = {
      hold: new BannerRow(host, {
        order: 1,
        testid: "geode-settings-hold-banner",
        icon: "file-warning",
        action: {
          label: "Review",
          testid: "geode-settings-review-missing",
          onClick: () => this.plugin.openMassDeleteReview(),
        },
      }),
      error: new BannerRow(host, {
        order: 2,
        testid: "geode-settings-error-banner",
        icon: "triangle-alert",
        action: {
          label: "Retry",
          testid: "geode-settings-error-retry",
          onClick: (btn) => {
            void this.plugin.retrySync(btn);
          },
        },
      }),
      pause: new BannerRow(host, {
        order: 3,
        testid: "geode-settings-pause-banner",
        icon: "pause",
        action: {
          label: "Resume",
          testid: "geode-settings-resume",
          onClick: () => {
            void this.plugin.resumeSync();
          },
        },
      }),
    };
  }

  private updateBanners(): void {
    this.updateHoldBanner();
    this.updateErrorBanner();
    this.updatePauseBanner();
    this.createVersionBanner();
  }

  /** A version change only rewrites the version row; the state rows stay in place. */
  updateVersionBanner(): void {
    this.createVersionBanner();
  }

  /** #601: the held mass-delete row sits above every other banner: it is the only state
   * that keeps sync from moving at all, and its Review opens the decision. */
  private updateHoldBanner(): void {
    const hold = this.getUnlocked() ? this.plugin.pluginSettings.massDeleteHold : null;
    this.banners?.hold.sync(
      hold
        ? {
          name: "Sync on hold",
          nameClasses: ["geode-hold-banner-name"],
          desc: filesMissing(hold.files.length),
        }
        : null,
    );
  }

  /** In-place degraded-sync banner below the hold. */
  private updateErrorBanner(): void {
    const banner = describeErrorBanner(
      this.plugin.getStatusInput(),
      Date.now(),
      this.plugin.pluginSettings.serverUrl,
    );
    this.banners?.error.sync(
      banner ? { name: banner.name, desc: banner.desc } : null,
    );
  }

  /** In-place pause banner (#443): below the error banner, name + age desc + [Resume], ticking via the status subscription. */
  private updatePauseBanner(): void {
    const banner = this.getUnlocked()
      ? describePauseBanner(this.plugin.getPausedAt(), Date.now())
      : null;
    this.banners?.pause.sync(
      banner
        ? {
          name: "Sync paused",
          nameClasses: [`geode-pause-banner-${banner.color}`],
          desc: banner.desc,
        }
        : null,
    );
  }

  updateVaultDesc(): void {
    this.vaultSection?.updateVaultDesc();
  }
}
