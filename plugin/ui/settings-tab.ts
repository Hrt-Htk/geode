import {
  App as ObsidianApp,
  ButtonComponent,
  Plugin,
  PluginSettingTab,
  requireApiVersion,
  type SettingDefinitionItem,
} from "obsidian";
import { isConfigured, type PluginSettings } from "../plumbing/settings-types.ts";
import { type LogEntry, setDebugLogging } from "../plumbing/log.ts";
import { openForgotModal } from "./forgot-modal.ts";
import { relativeTime } from "./trash-format.ts";
import { trashSettingsRows } from "./trash-settings.ts";
import type { VersionStatus } from "../sync/version-state.ts";
import { settingsDevicesRows } from "./settings-devices-section.ts";
import { SettingsBanners } from "./settings-banners.ts";
import { LegacySettingsView, type SettingsRow } from "./settings-legacy.ts";
import { definitionsOf, type TreeSection } from "./settings-tree.ts";
import { type SectionId, type TabState, tabStateOf, tabVisibility } from "./tab-state.ts";
import type { TrashApi } from "../plumbing/trash-client.ts";
import type { RejoinBackup } from "../sync/rejoin.ts";
import { SettingsLogsSection } from "./settings-logs-section.ts";
import { SettingsStatusSection } from "./settings-status-section.ts";
import { SettingsVaultSection } from "./settings-vault-section.ts";
import { SettingsScopeSection } from "./settings-scope-section.ts";
import { SettingsAdvancedSection } from "./settings-advanced-section.ts";
import type { SyncStatusInput } from "./sync-status.ts";
import type { ServerUpdate } from "./server-update.ts";
import type { StatusBar } from "./statusbar.ts";
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
  /** #44: the server's own version, and the run the row and the dialog describe. */
  serverVersion: string | null;
  updater: ServerUpdate;
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

/** The settings modal's untyped surface `refresh()` needs. */
type SettingsModal = { activeTab: unknown; openTabById(id: string): void };

export class GeodeSettingTab extends PluginSettingTab {
  /** E2E hook (#16): render through display() on Obsidian 1.13+ too, so one spec drives both. */
  legacyForTest = false;
  // display() only: Advanced + Logs start collapsed, for this session.
  private legacy = new LegacySettingsView(this, new Set(["advanced", "logs"]));
  private banners: SettingsBanners;
  private statusSection: SettingsStatusSection | null = null;
  private vaultSection: SettingsVaultSection | null = null;
  private logsSection: SettingsLogsSection | null = null;
  private trash: ReturnType<typeof trashSettingsRows> | null = null;
  // Scroll position to restore when the vault unlocks again within this tab session.
  private savedScrollTop = 0;
  private lastState: TabState | null = null;

  constructor(app: ObsidianApp, private plugin: PluginInstance, private statusBar: StatusBar) {
    super(app, plugin);
    // #458: keep the offset as the user scrolls. Locking hides rows, which clamps the pane
    // before applyLockState runs, so the transition itself cannot read it.
    this.containerEl.addEventListener("scroll", () => {
      if (this.getUnlocked()) this.savedScrollTop = this.containerEl.scrollTop;
    });
    this.banners = new SettingsBanners({
      settings: () => this.plugin.pluginSettings,
      getUnlocked: () => this.getUnlocked(),
      getStatusInput: () => this.plugin.getStatusInput(),
      getPausedAt: () => this.plugin.getPausedAt(),
      versionStatus: () => this.plugin.versionStatus,
      openMassDeleteReview: () => this.plugin.openMassDeleteReview(),
      retrySync: (btn) => this.plugin.retrySync(btn),
      resumeSync: () => this.plugin.resumeSync(),
      startServerUpdate: () => this.plugin.updater.prompt(),
    });
    this.statusBar.subscribe(() => {
      this.statusSection?.updateStatusRow();
      this.logsSection?.refreshDetails();
      this.banners.update();
      this.trash?.syncHold();
      this.refreshDom();
    });
  }

  private getUnlocked(): boolean {
    return typeof this.plugin.isUnlocked === "function"
      ? this.plugin.isUnlocked()
      : this.plugin.isUnlocked;
  }

  private state(): TabState {
    return tabStateOf(isConfigured(this.plugin.pluginSettings), this.getUnlocked());
  }

  /** #16: Obsidian 1.13+ renders these definitions and indexes them for settings search. A read:
   * Obsidian re-reads them on every keystroke in the search field, and the live rows stay bound to
   * the section objects the current DOM was rendered from. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.legacyForTest ? [] : definitionsOf(this.sections());
  }

  /** Obsidian < 1.13 (and the 1.13+ E2E hook): the same sections, collapsible. */
  display(): void {
    this.renderLegacy();
  }

  /** Re-render after a structural change (set up, leave, re-key). On 1.13+ a shown tab reopens
   * at its top: Leave runs from the Advanced page, which the new definitions no longer hold. */
  refresh(): void {
    if (requireApiVersion("1.13.0")) {
      this.rebuild();
      this.update();
      const setting = (this.app as unknown as { setting?: SettingsModal }).setting;
      if (setting?.activeTab === this) setting.openTabById(this.plugin.manifest.id);
    } else {
      this.renderLegacy();
    }
  }

  private renderLegacy(): void {
    this.rebuild();
    this.containerEl.empty();
    this.legacy.render(this.containerEl, this.sections());
    this.applyLockState();
  }

  /** A structural change: the tree and the scroll bookkeeping start over. */
  private rebuild(): void {
    this.savedScrollTop = 0;
    this.lastState = null;
    this.statusSection = null;
    this.vaultSection = null;
    this.logsSection = null;
    this.trash = null;
  }

  /** Re-evaluate every `visible` in place, on whichever path rendered the tab. */
  private refreshDom(): void {
    this.legacy.refreshVisibility();
    if (requireApiVersion("1.13.0")) this.refreshDomState();
  }

  getControlValue(key: string): unknown {
    return (this.plugin.pluginSettings as unknown as Record<string, unknown>)[key];
  }

  /** The four real controls: auto lock hours, trash retention days, Developer console (mirrors the
   * log to the DevTools console), sync config folder. The last two carry side effects; Config to
   * sync follows `visible`. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.pluginSettings as unknown as Record<string, unknown>)[key] = value;
    if (key === "debugLogging") setDebugLogging(value === true);
    await this.plugin.saveSettings();
    if (key === "syncObsidianConfig") {
      this.plugin.setSyncObsidianConfig(value === true);
      void this.plugin.reconcileNow();
    }
  }

  /** The whole tab for the current state. Section objects are built once and reused, so a re-read
   * of the definitions (search indexing) cannot unbind the live rows; `rebuild()` starts over. */
  private sections(): TreeSection<SettingsRow>[] {
    this.statusSection ??= new SettingsStatusSection({
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
      getServerUpdateInput: () =>
        this.plugin.updater.input(
          this.plugin.serverVersion,
          this.plugin.versionStatus.kind === "blocked" &&
            this.plugin.versionStatus.side === "server",
        ),
      startServerUpdate: () => this.plugin.updater.prompt(),
      copyUpdateCommand: () => this.plugin.updater.copyCommand(),
    });
    const status: TreeSection<SettingsRow> = {
      id: "status",
      heading: "Status",
      kind: "lead",
      rows: this.statusSection.rows(),
    };
    if (this.state() === "notset") return [status];
    return [...this.banners.sections(), status, ...this.configuredSections()];
  }

  /** Configured-state sections; all but Vault hide while locked (#458, #134). */
  private configuredSections(): TreeSection<SettingsRow>[] {
    const shown = (id: SectionId) => () => tabVisibility(this.state()).sections.includes(id);
    const settings = () => this.plugin.pluginSettings;
    this.vaultSection ??= new SettingsVaultSection({
      app: this.app,
      state: () => this.state(),
      settings,
      saveSettings: () => this.plugin.saveSettings(),
      lockVault: () => this.plugin.lockVault(),
      openRekeyModal: (kind) => this.plugin.openRekeyModal(kind),
      rekeyPaused: () => this.plugin.rekeyPaused(),
    });
    this.trash ??= trashSettingsRows({
      settings: this.plugin.pluginSettings,
      saveSettings: () => void this.plugin.saveSettings(),
      openTrashModal: () => this.plugin.openTrashModal(),
      openMassDeleteReview: () => this.plugin.openMassDeleteReview(),
      getHold: () => this.plugin.pluginSettings.massDeleteHold,
      getUnlocked: () => this.getUnlocked(),
      trash: this.plugin.trash,
    });
    this.logsSection ??= new SettingsLogsSection({
      getTransportState: () => this.plugin.getTransportState(),
      getLastSeenSeq: () => this.plugin.getLastSeenSeq(),
      getPendingCount: () => this.plugin.getPendingCount(),
      getRecentLog: () => this.plugin.getRecentLog(),
      exportLog: () => this.plugin.exportLog(),
    });
    const vaultSection = this.vaultSection;
    const trash = this.trash;
    const logsSection = this.logsSection;
    return [
      { id: "vault", heading: "Vault", kind: "group", rows: vaultSection.rows() },
      {
        id: "devices",
        heading: "Devices",
        kind: "group",
        rows: this.devicesRows(),
        visible: shown("devices"),
      },
      {
        id: "scope",
        heading: "Sync scope",
        kind: "group",
        rows: new SettingsScopeSection({
          app: this.app,
          settings,
          selfPluginId: this.plugin.manifest.id,
          configDir: this.app.vault.configDir,
          saveSettings: () => this.plugin.saveSettings(),
          reconcileNow: () => this.plugin.reconcileNow(),
          catchUpFolders: (folders) => this.plugin.catchUpFolders(folders),
        }).rows(),
        visible: shown("scope"),
      },
      { id: "trash", heading: "Trash", kind: "group", rows: trash.rows, visible: shown("trash") },
      {
        id: "advanced",
        heading: "Advanced",
        kind: "page",
        rows: this.advancedRows(),
        visible: shown("advanced"),
      },
      // #453/#434/#64: after Advanced, reachable while unlocked without any setting.
      {
        id: "logs",
        heading: "Logs",
        kind: "page",
        rows: logsSection.rows(),
        visible: shown("logs"),
      },
    ];
  }

  private devicesRows(): SettingsRow[] {
    const s = this.plugin.pluginSettings;
    return settingsDevicesRows({
      app: this.app,
      serverUrl: s.serverUrl,
      vaultId: s.vaultId,
      currentDeviceId: s.deviceId,
      deviceToken: s.deviceToken,
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
    });
  }

  private advancedRows(): SettingsRow[] {
    return new SettingsAdvancedSection({
      app: this.app,
      settings: () => this.plugin.pluginSettings,
      saveSettings: () => this.plugin.saveSettings(),
      applyServerAddress: (url) => this.plugin.applyServerAddress(url),
      resyncFromScratch: () => this.plugin.resyncFromScratch(),
      leaveVault: () => this.plugin.leaveVault(),
      openRekeyModal: (kind) => this.plugin.openRekeyModal(kind),
    }).rows();
  }

  /** Closing the tab stops the Logs subscription and the Devices poll (#502); on 1.13+
   * Obsidian runs the row cleanups itself. */
  hide(): void {
    this.legacy.dispose();
    super.hide();
  }

  /** In-place state update: swap rows/buttons and hide whole sections (#458, #134); scrollTop survives lock (save/restore, #458). */
  applyLockState(): void {
    const state = this.state();
    const prev = this.lastState;
    this.lastState = state;
    this.statusSection?.setState(state);
    this.vaultSection?.setState(state);
    this.banners.update();
    this.trash?.syncHold();
    this.refreshDom();
    if (state === "unlocked" && prev === "locked") this.containerEl.scrollTop = this.savedScrollTop;
    this.trash?.refreshCount();
  }

  /** #446: the TrashModal calls this after any trash change so the settings live count stays in sync. */
  refreshTrashCount(): void {
    this.trash?.refreshCount();
  }

  /** A version change only rewrites the version rows; the state rows stay in place. */
  updateVersionBanner(): void {
    this.banners.updateVersion();
    this.refreshDom();
  }

  updateVaultDesc(): void {
    this.vaultSection?.updateVaultDesc();
  }

  /** #44: the update run changed state: re-describe its row now, not on the next tick. */
  updateServerUpdateRow(): void {
    this.statusSection?.updateServerUpdateRow();
  }
}
