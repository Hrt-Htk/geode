import { arraysEqual } from "./helpers/bytes.ts";
import { serveOnPortZero } from "./helpers/port.ts";
import { openDb } from "../server/db.ts";
import { blobRoutes } from "../server/blob-routes.ts";
import { vaultRoutes } from "../server/routes.ts";
import { getHub, hubStore } from "../server/ws.ts";
import { log as serverLog } from "../server/log.ts";
import { openStateDB, StateDB } from "../plugin/plumbing/state.ts";
import { Transport } from "../plugin/sync/transport.ts";
import { SyncManager } from "../plugin/sync/sync-manager.ts";
import { VaultEventHandler } from "../plugin/sync/events.ts";
import { ActivityRecorder } from "../plugin/sync/activity-log.ts";
import {
  exportDecryptedVault,
  ExportStats,
  rebuildFromScratch,
  RecoveryStats,
} from "../plugin/sync/recovery.ts";
import { deriveKeys, VaultKeys } from "../core/crypto.ts";
import { DEFAULT_SETTINGS, isSyncable, PluginSettings } from "../plugin/plumbing/settings-types.ts";
import { b64decode, b64encode } from "../core/protocol.ts";
import { type HelloRekeyDecision } from "../plugin/sync/rekey-signal.ts";
import {
  disposeSession,
  pauseSessionSync,
  reconnectAndWaitLive,
  startUnlockedSession,
} from "../plugin/session.ts";
import { rebuildVault, rejoinAction, startRebuildTransport } from "../plugin/sync/rebuild-flow.ts";
import {
  enterRekeyLockedState,
  unlockAfterRemoteRekeyFlow,
  unlockVault,
} from "../plugin/plumbing/vault-lock.ts";
import type { RekeyCursor } from "../plugin/sync/rekey-run.ts";
import { SERVER_VERSION } from "../server/version-gate.ts";
import { MASS_DELETE_NEEDS_RESUME, type MassDeleteHold } from "../plugin/sync/mass-delete-hold.ts";
import { isMarkdownPath, normalizeMarkdownLineEndings } from "../core/normalize.ts";

// ── FakeVault ──────────────────────────────────────────────────────────

export type VaultEvent =
  | { type: "create"; path: string }
  | { type: "modify"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; oldPath: string };

/**
 * Adapter class with regular (non-arrow) methods that rely on `this`.
 * Mirrors Android Obsidian's real CapacitorAdapter: extracting a method
 * to a variable and calling it unbound loses `this` and throws.
 */
class FakeVaultAdapter {
  constructor(private vault: FakeVault) {}

  readBinary(path: string): Promise<Uint8Array> {
    return this.vault.readBinary(path);
  }

  stat(path: string): Promise<{ size: number; mtime: number } | null> {
    return this.vault.stat(path);
  }

  writeBinary(path: string, data: Uint8Array, opts?: { mtime?: number }): Promise<void> {
    this.vault.writeBinary(path, data, opts);
    return Promise.resolve();
  }

  write(path: string, data: string, opts?: { mtime?: number }): void {
    this.vault.write(path, data, opts);
  }

  delete(path: string): Promise<void> {
    return this.vault.delete(path);
  }

  // The real Obsidian adapter exposes `remove`; mirror it so sync code that
  // calls adapter.remove (apply, conflict-resolve) runs unbound-safe here too.
  remove(path: string): Promise<void> {
    return this.vault.delete(path);
  }

  rename(from: string, to: string): void {
    this.vault.rename(from, to);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.vault.fileExists(path));
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.vault.list(path);
  }
}

// The driver's plugin-data dir (persisted state files). On-disk plugin data,
// not user vault files: kept out of `files` so scenario file counts match
// the real vault's user files.
export const PLUGIN_DATA_DIR = ".obsidian/plugins/geode/";

export class FakeVault {
  files = new Map<string, Uint8Array>();
  mtimes = new Map<string, number>();
  pluginData = new Map<string, Uint8Array>();
  /** Every rename this vault performed: #697 asserts an apply moves the file itself. */
  readonly renames: Array<{ from: string; to: string }> = [];
  configDir = ".obsidian";
  private listeners = new Set<(event: VaultEvent) => void>();
  private eventWrappers = new Map<(...args: unknown[]) => void, (event: VaultEvent) => void>();

  // Adapter with regular methods: extracting and calling unbound loses `this`.
  readonly adapter = new FakeVaultAdapter(this);

  private isPluginData(path: string): boolean {
    return path.startsWith(PLUGIN_DATA_DIR);
  }

  private dataMap(path: string): Map<string, Uint8Array> {
    return this.isPluginData(path) ? this.pluginData : this.files;
  }

  // The Vault event surface (plugin/sync/events.ts): wraps the VaultEvent
  // stream so the real VaultEventHandler runs unmodified against this vault.
  on(name: string, cb: (...args: unknown[]) => void): void {
    const wrapper = (event: VaultEvent) => {
      if (event.type !== name) return;
      if (name === "rename") cb({ path: event.path }, event.oldPath);
      else cb({ path: event.path });
    };
    this.eventWrappers.set(cb, wrapper);
    this.onEvent(wrapper);
  }

  off(_name: string, cb: (...args: unknown[]) => void): void {
    const wrapper = this.eventWrappers.get(cb);
    if (wrapper) {
      this.offEvent(wrapper);
      this.eventWrappers.delete(cb);
    }
  }

  onEvent(fn: (event: VaultEvent) => void): void {
    this.listeners.add(fn);
  }

  offEvent(fn: (event: VaultEvent) => void): void {
    this.listeners.delete(fn);
  }

  emit(event: VaultEvent): void {
    for (const fn of this.listeners) {
      fn(event);
    }
  }

  readBinary(path: string): Promise<Uint8Array> {
    const data = this.dataMap(path).get(path);
    if (!data) return Promise.reject(new Error(`file not found: ${path}`));
    return Promise.resolve(new Uint8Array(data));
  }

  write(path: string, content: string, opts?: { mtime?: number }): void {
    this.writeBinary(path, new TextEncoder().encode(content), opts);
  }

  writeBinary(path: string, data: Uint8Array, opts?: { mtime?: number }): void {
    if (this.isPluginData(path)) {
      // Plugin data (state files) is written by the persistence layer, not a
      // user edit: no markdown normalization, no vault event.
      this.pluginData.set(path, new Uint8Array(data));
      return;
    }
    const mtime = opts?.mtime ?? Date.now();
    // Ask before the write lands: a path the index does not hold yet is a `create` for
    // real Obsidian (#695), so the fake must report one too.
    const existing = this.files.has(path);
    // Normalize markdown line endings so merge tests assert logical content,
    // not platform-specific bytes.
    const normalized = isMarkdownPath(path)
      ? new TextEncoder().encode(normalizeMarkdownLineEndings(new TextDecoder().decode(data)))
      : data;
    this.files.set(path, new Uint8Array(normalized));
    this.mtimes.set(path, mtime);
    this.emit({
      type: existing ? "modify" : "create",
      path,
    });
  }

  // Real Obsidian's adapter.stat resolves null for a missing path (verified on
  // desktop and Android, #505): it does not throw.
  stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const data = this.dataMap(path).get(path);
    if (!data) return Promise.resolve(null);
    return Promise.resolve({
      size: data.length,
      mtime: this.mtimes.get(path) ?? Date.now(),
    });
  }

  // Config-dir files are on disk but NOT in the index: real Obsidian hides them from the
  // file API (see getAllLoadedFiles), so a write goes through the adapter fallback
  // (vault-io.ts) and the #498 "file is back" guard in commit.ts cannot see them.
  getAbstractFileByPath(path: string): { path: string } | null {
    if (path.startsWith(`${this.configDir}/`)) return null;
    return this.files.has(path) ? { path } : null;
  }

  createBinary(path: string, data: ArrayBuffer, opts?: { mtime?: number }): void {
    this.writeBinary(path, new Uint8Array(data), opts);
  }

  modifyBinary(file: { path: string }, data: ArrayBuffer, opts?: { mtime?: number }): void {
    this.writeBinary(file.path, new Uint8Array(data), opts);
  }

  delete(path: string | { path: string }): Promise<void> {
    const p = typeof path === "string" ? path : path.path;
    this.dataMap(p).delete(p);
    this.mtimes.delete(p);
    if (this.isPluginData(p)) return Promise.resolve();
    this.emit({ type: "delete", path: p });
    return Promise.resolve();
  }

  // Obsidian's Vault.rename(file, newPath). Scenarios hand it a bare path, the plugin's
  // apply hands the indexed handle, exactly as with the real vault.
  rename(file: { path: string } | string, newPath: string): void {
    const oldPath = typeof file === "string" ? file : file.path;
    const map = this.dataMap(oldPath);
    const data = map.get(oldPath);
    const mtime = this.mtimes.get(oldPath);
    if (!data) throw new Error(`rename source not found: ${oldPath}`);
    this.renames.push({ from: oldPath, to: newPath });
    map.delete(oldPath);
    this.mtimes.delete(oldPath);
    this.dataMap(newPath).set(newPath, new Uint8Array(data));
    this.mtimes.set(newPath, mtime ?? Date.now());
    if (this.isPluginData(oldPath)) return;
    this.emit({ type: "rename", path: newPath, oldPath });
  }

  getAllLoadedFiles(): Array<{ path: string }> {
    // Mirror real Obsidian: getAllLoadedFiles() returns only user notes + attachments,
    // NOT .obsidian/ config files (they are hidden from the file API).
    return [...this.files.keys()]
      .filter((path) => !path.startsWith(".obsidian/"))
      .map((path) => ({ path }));
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    const prefix = normalized === ""
      ? ""
      : (normalized.endsWith("/") ? normalized : normalized + "/");

    const files = new Set<string>();
    const folders = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (prefix && !filePath.startsWith(prefix)) continue;
      const relative = prefix ? filePath.slice(prefix.length) : filePath;
      if (!relative) continue;
      const parts = relative.split("/");
      // Obsidian returns full vault-relative paths (immediate children only, non-recursive).
      // E.g. adapter.list(".obsidian") → files: [".obsidian/app.json"], folders: [".obsidian/plugins"]
      if (parts.length === 1) {
        files.add(prefix ? prefix + parts[0] : parts[0]);
      } else {
        folders.add(prefix ? prefix + parts[0] : parts[0]);
      }
    }

    return Promise.resolve({ files: [...files], folders: [...folders] });
  }

  fileExists(path: string): boolean {
    return this.dataMap(path).has(path);
  }
}

// The KDF params the harness derives with: inside the server's band (#675) and
// cheap enough for tests. Shared so a re-key's switch params and a re-join's
// derivation can never disagree.
export const TEST_KDF = { ops: 1, mem: 8 * 1024 * 1024 };

// ── TestPlugin ─────────────────────────────────────────────────────────

export interface TestPluginOptions {
  url: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  /** Defaults to "test"; re-key scenarios re-join with the new passphrase. */
  passphrase?: string;
  saltBytes: Uint8Array;
  /** #560: the vault verifier this device stores (hello_ack hash comparison). */
  verifierB64?: string;
  pluginVersion?: string;
  /** #587: conflict files embed the device name; distinct names keep them apart. */
  deviceName?: string;
  onStatusUpdate?: (status: string, data?: unknown) => void;
}

// The test plugin IS a real SyncSessionHost/VaultLockHost: transport,
// syncManager, state and eventHandler are owned by the real session code
// (plugin/session.ts) and the real lock code (plugin/plumbing/vault-lock.ts),
// so lock/unlock/restart run the same dispose + session-restart path the
// plugin uses: not a driver-local reimplementation (#560 review, finding 5).
export class TestPlugin {
  fakeVault: FakeVault;
  keys: VaultKeys | null = null;
  settings: PluginSettings;
  transport: Transport | null = null;
  syncManager: SyncManager | null = null;
  state: StateDB | null = null;
  eventHandler: VaultEventHandler | null = null;
  deferredStartCleanup: (() => void) | null = null;
  /** #431: per-file sync activity; scenarios assert error rows recorded by catch-up failures. */
  activity: ActivityRecorder;
  isUnlocked = false;
  /** #560: the vault's passphrase changed on another device: stopped, no commits. */
  rekeyElsewhere = false;
  /** #560: a re-key session is running on another device: commit queue gated. */
  rekeyInProgress = false;
  lastBackupAt = 0;
  blockedNoticeShown = false;
  rekeyCursor: RekeyCursor | null = null;
  settingTab: { applyLockState(): void; display(): void } | null = null;
  statusBar: null = null;
  manifest: { version: string };
  isMobile = true;
  passphrase: string;
  /** Fake obsidian shell so the real session/lock code runs against the FakeVault. */
  readonly app: {
    vault: FakeVault;
    workspace: { onLayoutReady(cb: () => void): void };
    saveLocalStorage(key: string, value: unknown): void;
    loadLocalStorage(key: string): string | null;
  };
  private saltBytes: Uint8Array;
  private pluginVersion: string;
  private blocked = false;
  private onStatusUpdate: ((status: string, data?: unknown) => void) | null;
  private livePromise: Promise<void>;
  private liveResolve: () => void = () => {};

  constructor(opts: TestPluginOptions) {
    this.fakeVault = new FakeVault();
    this.passphrase = opts.passphrase ?? "test";
    this.saltBytes = opts.saltBytes;
    this.pluginVersion = opts.pluginVersion ?? SERVER_VERSION;
    this.onStatusUpdate = opts.onStatusUpdate ?? null;
    this.manifest = { version: this.pluginVersion };
    this.settings = {
      ...DEFAULT_SETTINGS,
      deviceName: opts.deviceName ?? "",
      serverUrl: opts.url,
      vaultId: opts.vaultId,
      deviceId: opts.deviceId,
      deviceToken: opts.deviceToken,
      salt: b64encode(opts.saltBytes),
      verifier: opts.verifierB64 ?? "",
    };
    this.app = {
      vault: this.fakeVault,
      // Synchronous layout: startUnlockedSession defers transport.start to
      // onLayoutReady; the test wants it immediate.
      workspace: { onLayoutReady: (cb) => cb() },
      saveLocalStorage: () => {},
      loadLocalStorage: () => null,
    };

    this.activity = new ActivityRecorder({
      now: () => Date.now(),
      deviceName: () => "test",
      myDeviceId: () => this.settings.deviceId,
      persist: () => {},
    });

    this.livePromise = new Promise((r) => {
      this.liveResolve = r;
    });
  }

  // ── SyncSessionHost / VaultLockHost injectables ──────────────────────────

  pluginDataPath(name: string): string {
    return `${PLUGIN_DATA_DIR}${name}`;
  }
  setSyncingProgress(_progress: { current: number; total: number } | null): void {}
  onVaultNameResolved(_name: string): void {}
  onServerVersion(_version: string): void {}
  onSyncCycleClean(): void {}
  onBlocked(_serverVersion: string, _clientVersion: string): void {}
  onMassDeleteHold(_hold: MassDeleteHold): void {}
  notify(_message: string, _timeoutMs?: number): void {}
  saveSettings(): Promise<void> {
    return Promise.resolve();
  }

  // #560: mirrors GeodePlugin.onHelloRekey (plugin/main.ts): pause while a
  // re-key runs elsewhere, dispose the runtime when the vault's verifier moved,
  // and restart the session when the re-key ends ("ok" after a pause).
  onHelloRekey(decision: HelloRekeyDecision): void {
    if (decision === "rekey-in-progress") {
      this.rekeyInProgress = true;
      this.syncManager?.pause();
    } else if (decision === "passphrase-changed") {
      this.rekeyInProgress = false;
      enterRekeyLockedState(this);
    } else if (this.rekeyInProgress) {
      this.rekeyInProgress = false;
      void this.restartUnlockedSession().catch((error) => {
        serverLog.error("test plugin failed to restart after re-key", {
          deviceId: this.settings.deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      this.rekeyInProgress = false;
    }
  }

  restartUnlockedSession(existingState?: StateDB): Promise<void> {
    // Mirrors GeodePlugin.restartUnlockedSession: an incomplete rejoin finishes instead of
    // starting a session over the rows it left armed.
    if (rejoinAction(this.settings) === "rejoin") return this.rejoinOverOldCopy().then(() => {});
    // Re-attach the test listeners: the restart builds a fresh Transport.
    return startUnlockedSession(this, existingState).then(() => {
      this.attachTestListeners();
    });
  }

  async start(): Promise<void> {
    this.keys = await deriveKeys(this.passphrase, this.saltBytes, {
      opsLimit: TEST_KDF.ops,
      memLimit: TEST_KDF.mem,
    });
    this.isUnlocked = true;
    await this.restartUnlockedSession();
    // #601: a held device deliberately never connects (no "live" to wait for).
    if (this.settings.massDeleteHold) this.liveResolve();
    if (this.onStatusUpdate) {
      // Chain the test spy after the session's own status handler.
      const sm = this.syncManager!;
      const sessionHandler =
        (sm as unknown as { onStatusUpdate: (s: string, d?: unknown) => void }).onStatusUpdate;
      sm.setOnStatusUpdate((status, data) => {
        sessionHandler(status, data);
        this.onStatusUpdate!(status, data);
      });
    }
    await this.livePromise;
    this.throwIfBlocked();
  }

  private attachTestListeners(): void {
    this.transport?.addEventListener("live", () => {
      this.liveResolve();
    });
    // A blocked (version-mismatched) plugin never goes live: resolve the
    // live-wait so start() returns instead of hanging the test harness.
    this.transport?.addEventListener("blocked", () => {
      this.blocked = true;
      this.liveResolve();
    });
  }

  stop(): void {
    disposeSession(this);
  }

  disconnect(): void {
    this.transport?.stop();
  }

  // Mirrors GeodePlugin.isPaused (plugin/main.ts): the persisted user pause.
  isPaused(): boolean {
    return this.settings.pauseAt > 0;
  }

  /** User pause: transport closed (no reconnect), commit queue gated. */
  pause(): void {
    pauseSessionSync(this);
  }

  /** Resume: ungate the commit queue, then reconnect (mirrors GeodePlugin.resumeSync,
   * including a rejoin it left incomplete). */
  async resume(): Promise<void> {
    if (rejoinAction(this.settings) === "rejoin") {
      this.settings.pauseAt = 0;
      await this.saveSettings();
      await this.rejoinOverOldCopy();
      return;
    }
    this.syncManager?.resume();
    await this.reconnect();
  }

  async reconnect(): Promise<void> {
    this.livePromise = new Promise((r) => {
      this.liveResolve = r;
    });
    this.transport?.start(
      this.settings.serverUrl,
      this.settings.vaultId,
      this.settings.deviceId,
      this.settings.deviceToken,
      this.state.getSyncCursor(),
      this.pluginVersion,
    );
    await this.livePromise;
    // Explicit start right after live (the session's "live" handler starts it
    // again after flushVersionQueue): the early scan sees the op still queued
    // and skips it, so a failing commit's retry budget is not reset mid-flight.
    this.syncManager?.startReconciler();
    this.throwIfBlocked();
  }

  /** #560: mirrors GeodePlugin.unlockVault: the remote-recovery flow when the
   * passphrase changed elsewhere, the local verifier path otherwise (which
   * itself falls back to the remote flow on a stale local verifier). */
  async unlock(passphrase: string): Promise<void> {
    this.rekeyInProgress = false;
    this.livePromise = new Promise((r) => {
      this.liveResolve = r;
    });
    if (this.rekeyElsewhere) {
      await unlockAfterRemoteRekeyFlow(this, passphrase);
    } else {
      await unlockVault(this, passphrase);
    }
    await this.livePromise;
    this.throwIfBlocked();
  }

  isBlocked(): boolean {
    return this.blocked;
  }

  isLive(): boolean {
    return this.transport?.isLive() ?? false;
  }

  /** A version-blocked plugin resolves the live-wait so start() returns instead of
   * hanging; make an UNEXPECTED block loud so a matched-version test can't silently
   * pass on one. Scenarios that intend to block catch this and assert isBlocked(). */
  private throwIfBlocked(): void {
    if (this.blocked) {
      throw new Error("transport blocked: client plugin version != server version");
    }
  }

  async flushPending(): Promise<void> {
    this.eventHandler?.flushNow();
    // Wait for the async commit chain to drain to the server.
    await this.waitForIdle();
  }

  async pushNow(): Promise<void> {
    this.eventHandler?.flushNow();
    await this.syncManager?.reconcileNow();
    await this.waitForIdle();
  }

  async reconcileNow(): Promise<void> {
    await this.syncManager?.reconcileNow();
    await this.waitForIdle();
  }

  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    await waitFor(
      () => (this.syncManager?.getPendingOps().length ?? 0) === 0,
      "commit queue to drain",
      timeoutMs,
    );
  }

  // Received or acked every version up to `seq`, and applied all of them.
  async waitForCaughtUp(seq: number, timeoutMs = 30_000): Promise<void> {
    await waitFor(
      () => (this.transport?.getLastSeenSeq() ?? 0) >= seq,
      `transport to reach seq ${seq}`,
      timeoutMs,
    );
    await this.syncManager?.flushVersionQueue();
  }

  async commitDirect(path: string): Promise<void> {
    // Commit a specific file directly, bypassing the event handler debounce.
    // Used for merge tests where timing matters.
    await this.syncManager?.handlePendingOps([{ path, kind: "commit" }]);
  }

  markLocalEdit(path: string): void {
    // Mark a path as having local edits so hasLocalEdits() returns true.
    // Used for merge tests where we need a conflict during replay.
    this.syncManager?.markLocalEdit(path);
  }

  clearLocalEdit(path: string): void {
    this.syncManager?.clearLocalEdit(path);
  }

  async waitForSyncCursor(seq: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((this.state?.getSyncCursor() ?? 0) >= seq) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`timeout waiting for sync cursor ${seq}`);
  }

  async waitForVersion(
    path: string,
    minVersion?: number,
    timeoutMs = 10_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = this.state?.getLocalFile(path);
      // A row with no version of its own is a carried edit or a rename destination waiting
      // for its note: not a version applied here, so it does not satisfy this wait (#697).
      const version = row?.last_seen_version ?? 0;
      if (row && !row.deleted && version > 0 && (!minVersion || version >= minVersion)) {
        // Also wait for the file to actually be written to the vault
        if (this.fakeVault.fileExists(path)) return;
      }
      await sleep(50);
    }
    throw new Error(`timeout waiting for version of ${path}`);
  }

  async waitForDeleted(path: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = this.state?.getLocalFile(path);
      if (row?.deleted && !this.fakeVault.fileExists(path)) return;
      await sleep(50);
    }
    throw new Error(`timeout waiting for deletion of ${path}`);
  }

  async waitForConvergence(other: TestPlugin, path: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const aData = this.fakeVault.files.get(path);
      const bData = other.fakeVault.files.get(path);
      if (aData && bData && arraysEqual(aData, bData)) return;
      if (!aData && !bData) return;
      await sleep(50);
    }
    throw new Error(`timeout waiting for convergence of ${path}`);
  }

  resetLocalState(): Promise<void> {
    const freshState = openStateDB();
    this.state?.close();
    this.state = freshState;
    this.syncManager?.setState(this.state, this.keys!);
    return Promise.resolve();
  }

  // Mirrors GeodePlugin.resyncFromScratch ("Resync from scratch"): rebuild, then restart
  // the real unlocked session. Divergence from the plugin (which rebuilds on the
  // persisted rows, see rebuild-flow.ts): the default here rebuilds from an empty
  // registry so the full-rebuild path is exercised: applyVersion skips versions the
  // state already tracks.
  async resyncFromScratch(opts: { fromPersisted?: boolean } = {}): Promise<RecoveryStats> {
    if (!this.keys) {
      throw new Error("plugin not started");
    }
    // #601: mirrors the plugin: a rebuild IS the restore-everything decision, so connect
    // first; the hold stays in force until the rebuild has returned (a half-finished one
    // must not let the remaining paths sync as deletes).
    const held = this.settings.massDeleteHold !== null;
    if (held) {
      if (this.isPaused()) throw new Error(MASS_DELETE_NEEDS_RESUME);
      await reconnectAndWaitLive(this);
    }
    const recoveryTransport = this.transport!;
    // #584: the real plugin rebuilds on the PERSISTED rows; pass fromPersisted to mirror
    // that (a parked move's anchor lives there), default stays the empty-registry path.
    const freshState = opts.fromPersisted
      ? openStateDB([...this.state!.getAllLocalFiles().values()])
      : openStateDB();
    disposeSession(this);
    try {
      const result = await rebuildFromScratch({
        vault: this.fakeVault as unknown as ConstructorParameters<typeof SyncManager>[1]["vault"],
        transport: recoveryTransport,
        state: freshState,
        keys: this.keys,
        vaultId: this.settings.vaultId,
        // The real plugin's scope check: the config dir (where the driver's
        // persisted state files live) is never syncable, so prune leaves it.
        isSyncable: (p) => isSyncable(p, this.fakeVault.configDir, this.settings),
        parkedMoves: () => this.settings.pendingMoveOuts,
      });

      if (held) {
        this.settings.massDeleteHold = null;
        await this.saveSettings();
      }
      this.livePromise = new Promise((resolve) => {
        this.liveResolve = resolve;
      });
      await this.restartUnlockedSession(freshState);
      await this.livePromise;
      this.throwIfBlocked();
      return result;
    } catch (error) {
      freshState.close();
      throw error;
    }
  }

  /** #701: a rejoin over an old copy, through the plugin's own path (rebuild-flow.ts):
   * the persisted rows and cursor are the witness, the rebuild runs over a bare transport
   * carrying the new device's credentials, and the server wins wherever the device did not
   * change the file. Scenario code must not re-implement it: a driver mirror that drifts
   * passes while the plugin stays broken (the failure #701 is about). */
  async rejoinOverOldCopy(): Promise<RecoveryStats> {
    if (!this.keys) {
      throw new Error("plugin not started");
    }
    const transport = startRebuildTransport(this);
    this.livePromise = new Promise((resolve) => {
      this.liveResolve = resolve;
    });
    try {
      const result = await rebuildVault(this, transport, true);
      // A paused device never connects: that is the expected outcome, not a hang.
      if (this.settings.pauseAt === 0) {
        await this.livePromise;
        this.throwIfBlocked();
      }
      return result;
    } finally {
      transport.stop();
    }
  }

  async exportDecryptedVault(targetDir: string): Promise<ExportStats> {
    if (!this.keys) {
      throw new Error("plugin not started");
    }
    return await exportDecryptedVault(targetDir, {
      transport: this.transport,
      keys: this.keys,
    });
  }
}

// ── Test server ────────────────────────────────────────────────────────

export interface TestServer {
  url: string;
  db: ReturnType<typeof openDb>;
  dataDir: string;
  adminToken: string;
  stop: () => Promise<void>;
}

export function startTestServer(adminToken = "test-admin"): TestServer {
  const dataDir = Deno.makeTempDirSync();
  const db = openDb(dataDir);

  const blobHandler = blobRoutes(dataDir, db);
  const vaultHandler = vaultRoutes(db, adminToken, dataDir);

  const { port, shutdown } = serveOnPortZero((req: Request) => {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleTestUpgrade(req, db, dataDir, url);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] === "blobs") {
      return blobHandler(req);
    }
    if (parts[0] === "vaults") {
      return vaultHandler(req);
    }
    return new Response("ok", { status: 200 });
  });

  const url = `http://localhost:${port}`;
  serverLog.info("test server started", { url });

  return {
    url,
    db,
    dataDir,
    adminToken,
    stop: async () => {
      await shutdown();
      // Close each VaultHub before clearing the store: each hub schedules an
      // idle setTimeout (VaultHub.scheduleIdle) that leaks if not cleared.
      for (const hub of hubStore.values()) await hub.close();
      hubStore.clear();
      db.close();
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch { /* ignore */ }
    },
  };
}

function handleTestUpgrade(
  req: Request,
  db: ReturnType<typeof openDb>,
  dataDir: string,
  url: URL,
): Response {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "vaults") {
    return new Response("missing vault_id", { status: 400 });
  }

  const vaultId = parts[1];
  const protocol = req.headers.get("sec-websocket-protocol") ?? "";
  if (!protocol.startsWith("bearer.")) {
    return new Response("bad protocol", { status: 400 });
  }
  const token = protocol.slice(7);
  if (token.length === 0) {
    return new Response("invalid token", { status: 400 });
  }

  // Look up device_id from token (FK constraint requires device UUID, not token)
  const deviceRow = db.prepare(
    "SELECT id FROM devices WHERE token = ? LIMIT 1",
  ).get(token) as { id: string } | null;
  if (!deviceRow) {
    return new Response("unknown device", { status: 401 });
  }

  const { response, socket } = Deno.upgradeWebSocket(req, { protocol });
  const hub = getHub(db, dataDir, vaultId);
  hub.handleConnection(socket, deviceRow.id).catch((e) => {
    serverLog.warn("hub error", { error: e.message });
  });
  return response;
}

// ── Pair ───────────────────────────────────────────────────────────────

export interface PairedVaults {
  A: TestPlugin;
  B: TestPlugin;
  server: TestServer;
  vaultId: string;
  stop: () => Promise<void>;
}

export async function pair(): Promise<PairedVaults> {
  const server = await startTestServer();
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  server.db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );

  const deviceIdA = crypto.randomUUID();
  const tokenA = randomToken();
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceIdA,
    vaultId,
    "device-A",
    tokenA,
  );

  const deviceIdB = crypto.randomUUID();
  const tokenB = randomToken();
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceIdB,
    vaultId,
    "device-B",
    tokenB,
  );

  const A = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId: deviceIdA,
    deviceToken: tokenA,
    passphrase: "test",
    saltBytes: salt,
    deviceName: "device-A",
  });

  const B = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId: deviceIdB,
    deviceToken: tokenB,
    passphrase: "test",
    saltBytes: salt,
    deviceName: "device-B",
  });

  await A.start();
  await B.start();

  return {
    A,
    B,
    server,
    vaultId,
    stop: async () => {
      A.stop();
      B.stop();
      await server.stop();
    },
  };
}

export interface TripleVaults {
  A: TestPlugin;
  B: TestPlugin;
  C: TestPlugin;
  server: TestServer;
  vaultId: string;
  stop: () => Promise<void>;
}

export async function triple(): Promise<TripleVaults> {
  const server = await startTestServer();
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  server.db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );

  const clients = await Promise.all([
    createTestPlugin(server, vaultId, salt, "device-A"),
    createTestPlugin(server, vaultId, salt, "device-B"),
    createTestPlugin(server, vaultId, salt, "device-C"),
  ]);

  const [A, B, C] = clients;

  return {
    A,
    B,
    C,
    server,
    vaultId,
    stop: async () => {
      A.stop();
      B.stop();
      C.stop();
      await server.stop();
    },
  };
}

// ── Large-vault seed ───────────────────────────────────────────────────

export interface SeededVault {
  server: TestServer;
  vaultId: string;
  seeder: TestPlugin;
  join(
    deviceName?: string,
    onStatusUpdate?: (status: string, data?: unknown) => void,
  ): Promise<TestPlugin>;
  stop(): Promise<void>;
}

/**
 * Pre-seeds a throwaway server with `count` file versions authored by a seeder
 * device, so a device that later joins cold-syncs a real replay backlog (the
 * #319 path: transport goes live before the buffer drains). Returns only once
 * the server actually holds `count` versions.
 */
export async function seedLargeVault(count: number): Promise<SeededVault> {
  const server = await startTestServer();
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  server.db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "seed-vault",
    salt,
    Date.now(),
  );

  const seeder = await createTestPlugin(server, vaultId, salt, "seeder");
  for (let i = 0; i < count; i++) {
    seeder.fakeVault.write(`note-${i.toString().padStart(4, "0")}.md`, `seed-note-${i}`);
  }
  await seeder.flushPending();
  await waitForServerVersionCount(server.db, vaultId, count);

  const joined: TestPlugin[] = [];
  return {
    server,
    vaultId,
    seeder,
    join: async (deviceName = "joiner", onStatusUpdate) => {
      const plugin = await createTestPlugin(server, vaultId, salt, deviceName, onStatusUpdate);
      joined.push(plugin);
      return plugin;
    },
    stop: async () => {
      for (const plugin of joined) plugin.stop();
      seeder.stop();
      await server.stop();
    },
  };
}

async function waitForServerVersionCount(
  db: TestServer["db"],
  vaultId: string,
  min: number,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    if (row.n >= min) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${min} file_versions in vault ${vaultId}`);
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Every version the vault holds (all paths). */
export function versionCount(server: TestServer, vaultId: string): number {
  const row = server.db
    .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { n: number };
  return row.n;
}

/** Versions the server holds for one path hash: one row per commit, so a duplicate commit shows up.
 * A client-side duplicate apply does not (it writes no row), so pair it with a write spy when the
 * assertion is about applies. */
export function pathVersionCount(
  server: TestServer,
  vaultId: string,
  pathHash: string,
): number {
  const row = server.db
    .prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
    )
    .get(vaultId, pathHash) as { n: number };
  return row.n;
}

/** Heads sitting in the server trash (what a plain delete leaves behind). */
export function trashCount(server: TestServer, vaultId: string): number {
  const row = server.db
    .prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?")
    .get(vaultId) as { n: number };
  return row.n;
}

/** Poll `predicate` until true or `timeoutMs` elapses. Throws on timeout. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function createTestPlugin(
  server: TestServer,
  vaultId: string,
  salt: Uint8Array,
  name: string,
  onStatusUpdate?: (status: string, data?: unknown) => void,
): Promise<TestPlugin> {
  const deviceId = crypto.randomUUID();
  const token = randomToken();
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    name,
    token,
  );

  const plugin = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId,
    deviceToken: token,
    passphrase: "test",
    saltBytes: salt,
    deviceName: name,
    onStatusUpdate,
  });
  await plugin.start();
  return plugin;
}

// ── Restart helper ─────────────────────────────────────────────────────

/** Stop the app, change the disk behind its back, start it again: a change the event
 * stream never saw (deleted or renamed while closed). */
export async function restartWithDiskChange(
  plugin: TestPlugin,
  server: { url: string },
  change: () => void,
): Promise<TestPlugin> {
  plugin.stop();
  change();
  return await restartPlugin(plugin, server);
}

/**
 * Rebuilds a TestPlugin with fresh in-memory state but preserved FakeVault disk
 * (including the persisted plugin-data state files) and the same device
 * credentials: verifier included, so a stale local verifier survives the
 * restart. Returns a NEW TestPlugin (the old one is stopped). With
 * `unlocked: false` the fresh plugin stays locked (no keys), mirroring a
 * restart into the passphrase modal.
 */
export async function restartPlugin(
  old: TestPlugin,
  server: { url: string },
  opts?: { unlocked?: boolean; settings?: Partial<PluginSettings> },
): Promise<TestPlugin> {
  const files = new Map(old.fakeVault.files);
  const mtimes = new Map(old.fakeVault.mtimes);
  old.stop();
  await sleep(200);
  const fresh = new TestPlugin({
    url: server.url,
    vaultId: old.settings.vaultId,
    deviceId: old.settings.deviceId,
    deviceToken: old.settings.deviceToken,
    passphrase: old.passphrase,
    saltBytes: b64decode(old.settings.salt),
    verifierB64: old.settings.verifier,
    deviceName: old.settings.deviceName,
  });
  for (const [p, d] of files) fresh.fakeVault.files.set(p, new Uint8Array(d));
  for (const [p, m] of mtimes) fresh.fakeVault.mtimes.set(p, m);
  for (const [p, d] of old.fakeVault.pluginData) {
    fresh.fakeVault.pluginData.set(p, new Uint8Array(d));
  }
  // Settings survive a restart (data.json in the real plugin): carry what a scenario needs.
  Object.assign(fresh.settings, opts?.settings ?? {});
  if (opts?.unlocked !== false) await fresh.start();
  return fresh;
}
