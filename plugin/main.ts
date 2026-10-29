import { ButtonComponent, Notice, Platform, Plugin, TFile } from "obsidian";
import { type VaultKeys } from "../core/crypto.ts";
import {
  createVaultFlow,
  joinWithAdminFlow,
  onWizardClosed,
  openActivityModal,
  openConflictsModal,
  openDevicesView,
  openHistoryModal,
  openMassDeleteReview,
  openPassphraseModal,
  openSettingsTab,
  openTrashModal,
  startSetupWizard,
} from "./ui/modals.ts";
import { formatError, getRecentLog, log, setDebugLogging } from "./plumbing/log.ts";
import { formatUserError } from "./plumbing/errors.ts";
import { formatLogExport } from "./ui/log-format.ts";
import { makeTrashApi, TrashApi } from "./plumbing/trash-client.ts";
import { Transport } from "./sync/transport.ts";
import { StateDB } from "./plumbing/state.ts";
import {
  blockedCopy,
  blockedSide,
  describeVersionHint,
  type VersionStatus,
} from "./sync/version-state.ts";
import { VaultEventHandler } from "./sync/events.ts";
import { SyncManager } from "./sync/sync-manager.ts";
import { ActivityRecorder } from "./sync/activity-log.ts";
import { wireConflictCount } from "./ui/conflicts-modal-host.ts";
import { countConflictFiles } from "./sync/conflict-list.ts";
import { mergePendingViews } from "./sync/pending-view.ts";
import { DEFAULT_SETTINGS, isConfigured, type PluginSettings } from "./plumbing/settings-types.ts";
import { GeodeSettingTab } from "./ui/settings-tab.ts";
import { runWithFeedback } from "./ui/button-feedback.ts";
import { exportVaultFlow } from "./sync/export-vault.ts";
import { rebuildVault, rejoinAction, startRebuildTransport } from "./sync/rebuild-flow.ts";
import { detectRejoin as detectRejoinState } from "./sync/join-plan.ts";
import { rejoinFailedNotice, rejoinResultText } from "./ui/setup-wizard-logic.ts";
import type { RejoinBackup } from "./sync/rejoin.ts";
import { StatusBar } from "./ui/statusbar.ts";
import type { SyncStatusInput } from "./ui/sync-status.ts";
import { SetupWizardModal } from "./ui/setup-wizard.ts";
import type { FileHistoryModal } from "./ui/history-modal.ts";
import { HISTORY_ENTRY_TITLE } from "./ui/history-view.ts";
import { registerCommands } from "./plumbing/commands.ts";
import { wirePlatformHttp } from "./plumbing/http-platform.ts";
import {
  disposeRuntime,
  enterRekeyLockedState,
  finishRekey,
  leaveVault,
  lockVault,
  restartUnlockedSession,
  tryCachedKeys,
  unlockAfterRemoteRekeyFlow,
  unlockVault as unlockVaultWithLocalKeys,
} from "./plumbing/vault-lock.ts";
import type { HelloRekeyDecision } from "./sync/rekey-signal.ts";
import {
  pauseSessionSync,
  readActivityFile,
  resumeSessionSync,
  writeActivityFile,
  writePluginDataFile,
} from "./session.ts";
import { makeRekeyCursorStore, readRekeyCursor } from "./plumbing/rekey-cursor-store.ts";
import type { RekeyCursor } from "./sync/rekey-run.ts";
import type { MassDeleteHold } from "./sync/mass-delete-hold.ts";
import { notifyMassDeleteHold } from "./ui/mass-delete-modal.ts";
import { RekeyModal } from "./ui/rekey-modal.ts";
import type { RekeyKind } from "./ui/rekey-modal-logic.ts";
import { readLastBackupAt } from "./plumbing/state-persistence.ts";
import { removeLegacyKeyCacheFile } from "./plumbing/key-cache.ts";
import { LIBSODIUM_WASM_BASE64 } from "./_generated/libsodium-wasm-base64.ts";
import { b64decode } from "../core/protocol.ts";

// libsodium's Emscripten loader tries to fetch its .wasm over the network in the
// Electron renderer, which hangs forever. Hand it the build-inlined binary via a
// global that the patched libsodium-sumo (see scripts/plugin-build.ts) reads at init.
{
  const g = globalThis as { __GEODE_LIBSODIUM_WASM__?: Uint8Array };
  g.__GEODE_LIBSODIUM_WASM__ ??= b64decode(LIBSODIUM_WASM_BASE64);
}

export default class GeodePlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  transport: Transport | null = null;
  syncManager: SyncManager | null = null;
  state: StateDB | null = null;
  eventHandler: VaultEventHandler | null = null;
  statusBar: StatusBar | null = null;
  /** #431: plugin-scope activity log, survives restarts and lock/unlock. */
  activity: ActivityRecorder | null = null;
  settingTab: GeodeSettingTab | null = null;
  setupWizardModal: SetupWizardModal | null = null;
  /** #464: the open file history modal; a lock, leave or re-key closes it. */
  historyModal: FileHistoryModal | null = null;
  keys: VaultKeys | null = null;
  isUnlocked = false;
  // #560: the vault's passphrase changed on another device: locked until the
  // user re-unlocks against the server's current verifier.
  rekeyElsewhere = false;
  // #560: a re-key session is running on another device: sync paused, no commits.
  rekeyInProgress = false;
  // #559: an open re-key cursor reopens the modal paused (row shows Resume).
  rekeyCursor: RekeyCursor | null = null;
  trash: TrashApi = makeTrashApi(() => this.settings, () => this.keys);
  versionStatus: VersionStatus = { kind: "ok" };
  // #433: in-memory admin token from the Devices view's privileged-action
  // prompt; never persisted (asked again next time Obsidian starts).
  adminToken: string | null = null;
  lastBackupAt = 0;
  blockedNoticeShown = false;
  private syncingProgress: { current: number; total: number } | null = null;
  deferredStartCleanup: (() => void) | null = null;
  // SyncSessionHost injectables (session.ts stays obsidian-free).
  isMobile = Platform.isMobile;
  notify(message: string, timeoutMs?: number): void {
    new Notice(message, timeoutMs);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rekeyCursor = await readRekeyCursor(
      (path) => this.app.vault.adapter.readBinary(path),
      this.pluginDataPath("rekey-cursor.json"),
    );
    this.activity = new ActivityRecorder({
      now: () => Date.now(),
      deviceName: () => this.settings.deviceName,
      myDeviceId: () => this.settings.deviceId,
      persist: (json) => writeActivityFile(this, json),
    });
    this.activity.load(await readActivityFile(this));
    // Show the persisted last-backup time before unlock, when StateDB doesn't
    // exist yet: sync-cursor.json is plain JSON.
    this.lastBackupAt = await readLastBackupAt(
      (path) => this.app.vault.adapter.readBinary(path),
      this.pluginDataPath("sync-cursor.json"),
    );
    setDebugLogging(this.settings.debugLogging);
    // #534: the key cache moved out of the vault folder; delete the legacy in-vault copy.
    removeLegacyKeyCacheFile(
      (path) => this.app.vault.adapter.exists(this.pluginDataPath(path)),
      (path) => this.app.vault.adapter.remove(this.pluginDataPath(path)),
    ).catch((error) => {
      log.warn("failed to remove legacy key cache file", { error: formatError(error) });
    });
    wirePlatformHttp();
    registerCommands(this);
    this.statusBar = new StatusBar(this);
    this.statusBar.setPausedAt(this.settings.pauseAt);
    wireConflictCount(this);
    this.registerInterval(window.setInterval(() => this.statusBar?.tick(), 1000));
    this.settingTab = new GeodeSettingTab(this.app, this, this.statusBar!);
    this.addSettingTab(this.settingTab);
    this.registerFileMenu();
    this.showStartupModal();
  }
  onunload(): void {
    this.activity?.flush();
    this.statusBar?.dispose();
    disposeRuntime(this, { clearKeys: true, updateStatus: false });
  }
  unlockVault(passphrase: string): Promise<void> {
    // #560: the passphrase changed on another device: fetch the vault's
    // current salt/verifier/params with the device token, verify, rebuild.
    if (this.rekeyElsewhere) {
      return unlockAfterRemoteRekeyFlow(this, passphrase);
    }
    return unlockVaultWithLocalKeys(this, passphrase);
  }

  // #560: hello_ack re-key signal (decided obsidian-free in rekey-signal.ts):
  // pause while a re-key runs elsewhere; lock when the vault's verifier moved.
  onHelloRekey(decision: HelloRekeyDecision): void {
    if (decision === "rekey-in-progress") {
      this.rekeyInProgress = true;
      this.syncManager?.pause();
    } else if (decision === "passphrase-changed") {
      this.rekeyInProgress = false;
      enterRekeyLockedState(this);
    } else if (this.rekeyInProgress) {
      // #560: the re-key ended (cancelled or switched): the pause is over, but
      // the "live" event that restarts the reconciler already fired, so
      // resume() alone leaves sync dead: restart the unlocked session.
      this.rekeyInProgress = false;
      void this.restartUnlockedSession().catch((error) => {
        log.error("failed to restart session after re-key ended", { error: formatError(error) });
      });
    } else {
      this.rekeyInProgress = false;
    }
  }
  lockVault(): void {
    lockVault(this);
  }
  leaveVault(): Promise<void> {
    return leaveVault(this);
  }
  isUnlockedCheck(): boolean {
    return this.isUnlocked;
  }
  pluginDataPath(name: string): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/${name}`;
  }
  async reconcileNow(): Promise<void> {
    await this.syncManager?.reconcileNow();
  }
  /** #342: a folder was switched back on in the Manage tree: catch up to the server heads. */
  async catchUpFolders(folders: string[]): Promise<void> {
    await this.syncManager?.catchUpFolders(folders);
  }
  setSyncObsidianConfig(value: boolean): void {
    this.syncManager?.setSyncObsidianConfig(value);
  }
  async pushNow(): Promise<void> {
    this.eventHandler?.flushNow();
    await this.syncManager?.reconcileNow();
  }
  isPaused(): boolean {
    return this.settings.pauseAt > 0;
  }
  getPausedAt(): number {
    return this.settings.pauseAt;
  }
  async pauseSync(): Promise<void> {
    if (this.isPaused() || !this.isUnlocked) return;
    this.settings.pauseAt = Date.now();
    await this.saveSettings();
    pauseSessionSync(this);
    this.statusBar?.setPausedAt(this.settings.pauseAt);
  }
  async resumeSync(): Promise<void> {
    if (!this.isPaused()) return;
    this.settings.pauseAt = 0;
    await this.saveSettings();
    if (rejoinAction(this.settings) === "rejoin") return this.finishIncompleteRejoin();
    resumeSessionSync(this);
    this.statusBar?.setPausedAt(0);
  }

  async resyncFromScratch(): Promise<void> {
    // #701: a failed rejoin left the rows armed; only the rejoin rebuild may run on them.
    if (rejoinAction(this.settings) === "rejoin") return this.finishIncompleteRejoin();
    if (!this.transport) throw new Error("vault must be unlocked before resync");
    new Notice("Geode: resyncing from scratch…");
    try {
      const result = await rebuildVault(this, this.transport);
      new Notice(`Geode: rebuilt ${result.appliedFiles} files from server`);
    } catch (error) {
      new Notice(`Geode: resync failed. ${formatUserError(error)}`);
      throw error;
    }
  }

  /** #701: the join landed on an old copy of this vault: rebuild over a transport with
   * the device token the join just issued (the live session still holds the old one, a
   * revoked one), then report where the doubt was set aside. */
  async beginRejoinRebuild(): Promise<RejoinBackup | null> {
    const transport = startRebuildTransport(this);
    try {
      const backup = (await rebuildVault(this, transport, true)).backup;
      // Not an unconditional zero: a pause the user chose survives a rejoin.
      this.statusBar?.setPausedAt(this.settings.pauseAt);
      return backup;
    } catch (error) {
      // #701: show the stop at once: the bar would otherwise keep saying disconnected.
      this.statusBar?.setPausedAt(this.settings.pauseAt);
      throw error;
    } finally {
      transport.stop();
    }
  }

  /** #701: one finish at a time: Resume and a session start can both fire. */
  private rejoinInFlight: Promise<void> | null = null;

  /** #701: a failed rejoin left the old rows armed and sync paused. Finish the rejoin
   * before any session starts on them; a failure here leaves the marker set, so the next
   * attempt tries again. */
  private finishIncompleteRejoin(): Promise<void> {
    this.rejoinInFlight ??= this.runIncompleteRejoin().finally(() => {
      this.rejoinInFlight = null;
    });
    return this.rejoinInFlight;
  }

  private async runIncompleteRejoin(): Promise<void> {
    try {
      const backup = await this.beginRejoinRebuild();
      if (backup) new Notice(rejoinResultText(backup.count, backup.folder));
    } catch (error) {
      log.error("incomplete rejoin failed", { error: formatError(error) });
      new Notice(rejoinFailedNotice(), 15000);
    }
  }

  detectRejoin(vaultId: string): Promise<boolean> {
    return detectRejoinState(this, vaultId);
  }

  getPendingOps() {
    return mergePendingViews(
      this.eventHandler?.getPendingOps() ?? [],
      this.syncManager?.getPendingOps() ?? [],
    );
  }
  getTransportState(): string {
    // #453: the Logs details line needs the state word; blocked wins over the
    // live connection state (a version mismatch stops sync even when connected).
    if (this.transport?.isBlocked()) return "blocked";
    return this.transport?.getState() ?? "disconnected";
  }

  /** #522: the single status input both the settings row and the activity footer describe. */
  getStatusInput(): SyncStatusInput {
    return {
      ...this.statusBar!.getIconInput(),
      lastBackupAt: this.lastBackupAt,
      rekeyElsewhere: this.rekeyElsewhere,
      rekeyInProgress: this.rekeyInProgress,
    };
  }

  getLastSeenSeq(): number {
    return this.transport?.getLastSeenSeq() ?? this.state?.getSyncCursor() ?? 0;
  }
  getPendingCount(): number {
    return this.getPendingOps().length;
  }

  getConflictCount(): number {
    return this.syncManager?.getConflictCount() ??
      countConflictFiles(this.app.vault.getAllLoadedFiles());
  }
  getRecentLog() {
    return getRecentLog();
  }
  exportLog(): string {
    return formatLogExport(this.getRecentLog());
  }
  openTrashModal(): void {
    openTrashModal(this);
  }
  openDevicesView(): void {
    openDevicesView(this);
  }
  openConflictsModal(): void {
    openConflictsModal(this);
  }
  openActivityModal(): void {
    openActivityModal(this);
  }
  /** #601: the notice, the status menu and the settings row converge here. */
  openMassDeleteReview(): void {
    openMassDeleteReview(this);
  }
  onMassDeleteHold(hold: MassDeleteHold): void {
    notifyMassDeleteHold(hold, () => this.openMassDeleteReview());
  }
  /** #464: file history; the activity row, the file menu, and the command converge here. */
  openFileHistory(path: string): void {
    openHistoryModal(this, { path });
  }
  /** #464: "Geode: Show file history" on any file in the explorer menu, offered
   * only while a vault is unlocked (history needs the keys to decrypt). */
  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.keys || !this.transport) return;
        menu.addItem((item) => {
          item.setTitle(HISTORY_ENTRY_TITLE).setIcon("history");
          item.onClick(() => this.openFileHistory(file.path));
        });
      }),
    );
  }
  openSettingsTab(): void {
    openSettingsTab(this);
  }
  isConfigured(): boolean {
    return isConfigured(this.settings);
  }

  setSyncingProgress(progress: { current: number; total: number } | null): void {
    this.syncingProgress = progress;
  }
  onVaultNameResolved(name: string): void {
    this.settings.vaultName = name;
    void this.saveSettings()
      .then(() => this.settingTab?.updateVaultDesc())
      .catch((error) => {
        log.error("failed to persist vault name", { error: formatError(error) });
      });
  }
  onBlocked(serverVersion: string, clientVersion: string, reason: string): void {
    const side = blockedSide(clientVersion, serverVersion, reason);
    this.versionStatus = { kind: "blocked", side };
    this.statusBar?.setVersionStatus(this.versionStatus);
    this.settingTab?.updateVersionBanner();
    if (!this.blockedNoticeShown) {
      this.blockedNoticeShown = true;
      new Notice(blockedCopy(side).notice, 15000);
    }
  }

  onSyncCycleClean(): void {
    this.lastBackupAt = this.state?.recordBackup(Date.now()) ?? this.lastBackupAt;
  }

  /** #529: hello_ack reported a compatible but different server version: show the update hint, keep syncing. */
  onServerVersion(serverVersion: string): void {
    const own = this.manifest.version;
    const hint = describeVersionHint(own, serverVersion);
    this.versionStatus = hint === null
      ? { kind: "ok" }
      : { kind: "hint", own, server: serverVersion };
    this.statusBar?.setVersionStatus(this.versionStatus);
    this.settingTab?.updateVersionBanner();
  }

  retrySync(btn: ButtonComponent): Promise<void> {
    return runWithFeedback(btn, "Retrying…", "Geode: retry started", () => {
      const state = this.transport?.getState();
      if (state === "disconnected" || state === "connecting") {
        this.transport?.retryNow();
      } else {
        void this.syncManager?.retryDropped();
      }
    });
  }

  private async loadSettings(): Promise<void> {
    const data = await this.loadData() ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }
  saveSettings(): Promise<void> {
    return this.saveData(this.settings as unknown as Record<string, unknown>);
  }
  createVaultFlow(
    opts: {
      serverUrl: string;
      adminToken: string;
      vaultName: string;
      deviceName: string;
      passphrase: string;
      argon2Params?: { ops: number; mem: number };
    },
    keepWizardOpen = false,
  ): Promise<void> {
    return createVaultFlow(this, opts, keepWizardOpen);
  }

  joinWithAdminFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  }, keepWizardOpen = false): Promise<{ rejoin: RejoinBackup | null }> {
    return joinWithAdminFlow(this, opts, keepWizardOpen);
  }

  openPassphraseModal(): void {
    openPassphraseModal(this);
  }

  // #559: change-passphrase / re-key modal, entered from the Vault and
  // Advanced settings rows. An open cursor reopens the run paused.
  rekeyPaused(): boolean {
    return this.rekeyCursor !== null;
  }
  openRekeyModal(kind: RekeyKind): void {
    if (!this.isUnlocked || !this.keys) return;
    const store = makeRekeyCursorStore(
      (bytes) => writePluginDataFile(this, "rekey-cursor.json", bytes),
      this.rekeyCursor,
    );
    new RekeyModal(
      this.app,
      {
        settings: () => this.settings,
        keys: () => this.keys,
        isMobile: this.isMobile,
        cursor: () => store,
        finishRekey: async (newKeys, params, verifierB64) => {
          await finishRekey(this, newKeys, params, verifierB64);
          // The re-key is over for this device: its next hello_ack is "ok",
          // and the flag must not trigger a second session restart.
          this.rekeyInProgress = false;
          this.rekeyCursor = null;
          this.settingTab?.display();
        },
      },
      kind,
    ).open();
  }

  // #440: setup wizard, tracked so the forgot flow can replace an open one.
  startSetupWizard(): void {
    startSetupWizard(this);
  }
  onWizardClosed(): void {
    onWizardClosed(this);
  }
  /** #464: locked, left, or re-keyed: the history modal holds stale decryptions. */
  onKeysChanged(): void {
    this.historyModal?.close();
  }

  async exportDecryptedVault(targetDir: string): Promise<void> {
    await exportVaultFlow(this, targetDir);
  }
  restartUnlockedSession(existingState?: StateDB): Promise<void> {
    // #701: a failed rejoin left the old rows armed: finish the rejoin, never start a
    // session that would replay them. A successful rejoin clears the marker first, so the
    // restart inside the rebuild takes this branch once, not in a loop.
    if (rejoinAction(this.settings) === "rejoin") return this.finishIncompleteRejoin();
    return restartUnlockedSession(this, existingState);
  }
  // #424: save the new server address and apply it live: restart the unlocked
  // session against the new URL (vault stays unlocked, cursor kept). A later
  // reconnect failure surfaces via the #339 banner, not here. Serialized: one
  // in-flight apply; a second call queues behind the first so disk and memory
  // end on the latest URL.
  private serverAddressChain: Promise<void> = Promise.resolve();
  applyServerAddress(url: string): Promise<void> {
    const apply = async (): Promise<void> => {
      this.settings.serverUrl = url;
      await this.saveSettings();
      if (!this.isUnlocked) return;
      await this.restartUnlockedSession();
    };
    const run = this.serverAddressChain.then(apply);
    // The chain keeps going even if one apply fails; callers still see their own rejection.
    this.serverAddressChain = run.catch(() => {});
    return run;
  }
  private showStartupModal(): void {
    if (!isConfigured(this.settings)) {
      startSetupWizard(this);
      return;
    }
    if (!this.isUnlocked) {
      void tryCachedKeys(this)
        .then((cachedOk) => {
          if (!cachedOk) openPassphraseModal(this);
        })
        .catch(() => openPassphraseModal(this));
    }
  }
}
