import type { VaultKeys } from "../core/crypto.ts";
import { formatError, log } from "./plumbing/log.ts";
import { isSyncable, type PluginSettings } from "./plumbing/settings-types.ts";
import { retryPendingCatchUp } from "./plumbing/scope-pending.ts";
import { openStateDB, type StateDB } from "./plumbing/state.ts";
import {
  loadPersistedState,
  type StatePaths,
  wireStatePersistence,
} from "./plumbing/state-persistence.ts";
import { atomicWriteBinary } from "./plumbing/atomic-write.ts";
import { Transport } from "./sync/transport.ts";
import { SyncManager } from "./sync/sync-manager.ts";
import { type HelloRekeyDecision, helloRekeyDecision } from "./sync/rekey-signal.ts";
import { shouldStampBackup } from "./sync/backup-stamp.ts";
import { VaultEventHandler } from "./sync/events.ts";
import { ActivityRecorder } from "./sync/activity-log.ts";
import { reconcileVaultName } from "./sync/vault-name-heal.ts";
import { type MassDeleteHold } from "./sync/mass-delete-hold.ts";

type VaultEventHost = ConstructorParameters<typeof VaultEventHandler>[0];
type SyncVault = ConstructorParameters<typeof SyncManager>[1]["vault"];

/** #601: how long a decision/rebuild waits for the reconnect before giving up. */
const RECONNECT_TIMEOUT_MS = 30_000;

export interface SyncSessionStatusBar {
  updateDirty(n: number): void;
  clearSyncingProgress(): void;
  updateLastSync(): void;
  updateLastAck(): void;
  updateSyncingProgress(current: number, total: number): void;
  updatePending(n: number): void;
  updateDropped(n: number): void;
  updateRetries(n: number): void;
  updateConflicts(n: number): void;
  updateState(state: string): void;
  /** #601: the held mass delete, rendered as its own status (not a connecting spinner). */
  setMassDeleteHold(hold: MassDeleteHold | null): void;
  updateReconnectDelay(ms: number): void;
  clearOffline(): void;
}

export interface SyncSessionHost {
  keys: VaultKeys | null;
  settings: PluginSettings;
  manifest: { version: string };
  app: {
    vault: { adapter: unknown; configDir: string };
    workspace: { onLayoutReady(cb: () => void): void };
  };
  pluginDataPath(name: string): string;
  statusBar: SyncSessionStatusBar | null;
  setSyncingProgress(progress: { current: number; total: number } | null): void;
  transport: Transport | null;
  syncManager: SyncManager | null;
  state: StateDB | null;
  eventHandler: VaultEventHandler | null;
  deferredStartCleanup: (() => void) | null;
  /** #431: plugin-scope activity log; the session feeds it sync events. */
  activity: ActivityRecorder | null;
  onVaultNameResolved(name: string): void;
  /** #560: hello_ack re-key signal: pause, or enter the locked "passphrase changed elsewhere" state. */
  onHelloRekey(decision: HelloRekeyDecision): void;
  onBlocked(serverVersion: string, clientVersion: string, reason: string): void;
  /** #601: a held mass delete: raise the clickable notice that opens the review. */
  onMassDeleteHold(hold: MassDeleteHold): void;
  /** #529: hello_ack carries the server version; the plugin surfaces an update hint when it differs. */
  onServerVersion(serverVersion: string): void;
  onSyncCycleClean(): void;
  saveSettings: () => Promise<void>;
  // Obsidian shell injectables (kept out of this module so it stays
  // obsidian-free and unit-testable).
  notify(message: string, timeoutMs?: number): void;
  isMobile: boolean;
}

export function disposeSession(host: SyncSessionHost): void {
  if (appliedSeqReportTimer) clearTimeout(appliedSeqReportTimer);
  appliedSeqReportTimer = null;
  host.deferredStartCleanup?.();
  host.deferredStartCleanup = null;
  host.eventHandler?.stop();
  host.eventHandler = null;
  host.syncManager?.stop();
  host.syncManager = null;
  host.transport?.stop();
  host.transport = null;
  host.state?.close();
  host.state = null;
}

export async function openSessionState(host: SyncSessionHost): Promise<StateDB> {
  const paths: StatePaths = {
    localFiles: host.pluginDataPath("local-files.json"),
    cursor: host.pluginDataPath("sync-cursor.json"),
  };
  const adapter = host.app.vault.adapter as {
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  const read: (path: string) => Promise<ArrayBuffer | Uint8Array> = (path) =>
    adapter.readBinary(path);
  const result = await loadPersistedState(read, paths);
  const state = openStateDB(result.persisted, result.persistedCursor, result.lastBackupAt);
  const write = (path: string, bytes: Uint8Array) => writeStateFile(host, path, bytes);
  wireStatePersistence(state, write, paths);
  return state;
}

// #744: a state write is not awaited by its caller, so a leave that disposes the
// runtime (which flushes the state) must drain these before deleting the files.
const inFlightStateWrites = new Set<Promise<void>>();

// #181: device-gated state write: direct on mobile, temp-file+rename on
// desktop. Shared by the state files and the activity log (a torn activity
// file reads as null → empty log, never a crash).
function writeStateFile(host: SyncSessionHost, path: string, bytes: Uint8Array): void {
  const adapter = host.app.vault.adapter as {
    writeBinary(path: string, data: Uint8Array): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  const write = host.isMobile
    ? adapter.writeBinary(path, bytes)
    : atomicWriteBinary(adapter, path, bytes);
  inFlightStateWrites.add(write);
  const settle = () => {
    inFlightStateWrites.delete(write);
  };
  void write.then(settle, settle);
}

/** #744: wait until no state write is in flight. */
export async function awaitStateWrites(): Promise<void> {
  while (inFlightStateWrites.size > 0) {
    await Promise.allSettled([...inFlightStateWrites]);
  }
}

export function writeActivityFile(host: SyncSessionHost, json: string): void {
  writeStateFile(host, host.pluginDataPath("activity-log.json"), new TextEncoder().encode(json));
}

/** #559: the re-key cursor file rides the same device-gated state writer. */
export function writePluginDataFile(host: SyncSessionHost, name: string, bytes: Uint8Array): void {
  writeStateFile(host, host.pluginDataPath(name), bytes);
}

export async function readActivityFile(host: SyncSessionHost): Promise<string | null> {
  try {
    const adapter = host.app.vault.adapter as { readBinary(path: string): Promise<ArrayBuffer> };
    const raw = await adapter.readBinary(host.pluginDataPath("activity-log.json"));
    return new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

export async function startUnlockedSession(
  host: SyncSessionHost,
  existingState?: StateDB,
): Promise<void> {
  if (!host.keys) throw new Error("vault must be unlocked");
  disposeSession(host);
  const state = existingState ?? await openSessionState(host);
  if (existingState) {
    // #560: disposeSession closed this state (hooks nulled); re-attach the
    // device-gated writer so its rows persist under the new session.
    const paths: StatePaths = {
      localFiles: host.pluginDataPath("local-files.json"),
      cursor: host.pluginDataPath("sync-cursor.json"),
    };
    wireStatePersistence(state, (path, bytes) => writeStateFile(host, path, bytes), paths);
  }
  host.state = state;
  host.transport = new Transport();
  attachTransportListeners(host, host.transport);
  host.transport.setCursorSink((seq) => host.state?.advanceSyncCursor(seq));
  host.syncManager = new SyncManager(host.transport, {
    vault: host.app.vault as unknown as SyncVault,
    settings: host.settings,
    configDir: host.app.vault.configDir,
    recordActivity: host.activity ? (input) => host.activity!.record(input) : undefined,
    persistScope: () => host.saveSettings(),
    reconnect: () => reconnectAndWaitLive(host),
  });
  host.syncManager.setState(state, host.keys);
  host.syncManager.setOnStatusUpdate((status, data) => handleSyncStatus(host, status, data));
  // #601: a held mass delete: the whole sync waits for a decision. The announcement owns
  // the status bar's hold; clearing it on a decision is not an announcement.
  host.syncManager.setOnMassDeleteHoldChanged((hold) => {
    if (hold) announceMassDeleteHold(host, hold);
    else host.statusBar?.setMassDeleteHold(null);
  });
  host.eventHandler = new VaultEventHandler(
    host.app.vault as unknown as VaultEventHost,
    (ops) => {
      void host.syncManager?.handlePendingOps(ops).catch((error) => {
        log.error("failed to handle pending ops", { error: formatError(error) });
      });
    },
    (filePath) => isSyncable(filePath, host.app.vault.configDir, host.settings),
    (count) => host.statusBar?.updateDirty(count),
    // #342/#584: moves across the excluded-folder boundary: a file moved out is
    // parked (row tombstoned, no server delete) and its rename link is written when the
    // move resolves: back into scope under any name, or when the folder re-includes.
    {
      movedOut: (oldPath, newPath) => host.syncManager?.parkedMoves.park(oldPath, newPath),
      movedInside: (from, to) => host.syncManager?.parkedMoves.repoint(from, to),
      movedBack: (from, to) => host.syncManager?.parkedMoves.relink(from, to) ?? false,
      deleted: (path) => host.syncManager?.parkedMoves.deleted(path),
    },
  );
  host.syncManager.setSelfWriteSuppressor((p) => host.eventHandler?.suppressSelfWrite(p));
  host.syncManager.setSelfRenameSuppressor((from, to) =>
    host.eventHandler?.suppressSelfRename(from, to) ?? (() => {})
  );
  // #583: the event layer's un-flushed ops are invisible to the commit queue, so an
  // inbound version could be applied over an edit (or a rename) still in its window.
  host.syncManager.setPendingEventOps(() => host.eventHandler?.getPendingOps() ?? []);
  // #593: a remote edit that wins over a delete still in that window drops it there.
  host.syncManager.setPendingDeleteCanceller((p) => host.eventHandler?.cancelPendingDelete(p));
  // #465: a restore must land an edit still inside that window as its own version.
  host.syncManager.setEditFlusher(() => host.eventHandler?.flushNow());
  // A persisted pause survives restart: gate the queue now, skip transport.start
  // below, and keep the event handler counting local edits until resume.
  if (host.settings.pauseAt > 0) host.syncManager.pause();
  // #601: a persisted hold survives restart the same way (the manager gates itself on
  // construction): no transport, and the notice explains why the device is offline.
  const persistedHold = host.settings.massDeleteHold;
  if (persistedHold) announceMassDeleteHold(host, persistedHold);

  // Defer transport.start + eventHandler.start to onLayoutReady so a large
  // vault backlog doesn't monopolize startup and trip the mobile crash-guard.
  const deferredStart = () => {
    if (host.settings.pauseAt === 0 && host.settings.massDeleteHold === null) startTransport(host);
    host.eventHandler?.start();
  };
  // onLayoutReady returns void, so cancellation rides a flag: dispose flips it,
  // preventing a deferred transport.start from firing after dispose.
  let cancelled = false;
  host.deferredStartCleanup = () => {
    cancelled = true;
  };
  host.app.workspace.onLayoutReady(() => {
    if (cancelled) return;
    deferredStart();
  });
}

/** Start the transport from the persisted cursor. Non-null guarded: no-op unless the session is up and configured. */
function startTransport(host: SyncSessionHost): void {
  const state = host.state;
  if (!host.transport || !state || !host.settings.serverUrl) return;
  host.transport.start(
    host.settings.serverUrl,
    host.settings.vaultId,
    host.settings.deviceId,
    host.settings.deviceToken,
    state.getSyncCursor(),
    host.manifest.version,
  );
}

/** #601: a held mass delete is visible as the notice (which opens the review) and as
 * the status bar's "on hold" state. */
function announceMassDeleteHold(host: SyncSessionHost, hold: MassDeleteHold): void {
  host.statusBar?.setMassDeleteHold(hold);
  host.onMassDeleteHold(hold);
}

/** A held list's decision (or a rebuild) needs the connection back: reconnect from the
 * persisted cursor and resolve on "live", rejecting when the server never answers. */
export function reconnectAndWaitLive(
  host: SyncSessionHost,
  timeoutMs = RECONNECT_TIMEOUT_MS,
): Promise<void> {
  const transport = host.transport;
  if (!transport) return Promise.reject(new Error("sync is not running"));
  if (transport.isLive()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      transport.removeEventListener("live", done);
      resolve();
    };
    const timer = setTimeout(() => {
      transport.removeEventListener("live", done);
      reject(new Error("reconnect timed out: needs a connection"));
    }, timeoutMs);
    transport.addEventListener("live", done);
    startTransport(host);
  });
}

/** User pause: stop the transport (no reconnect) and gate the queue + reconciler. */
export function pauseSessionSync(host: SyncSessionHost): void {
  host.transport?.stop();
  host.syncManager?.pause();
}

/** Resume: ungate, clear the offline window, and reconnect from the persisted cursor. */
export function resumeSessionSync(host: SyncSessionHost): void {
  // #601: a hold is not a pause: resuming lifts the user pause (the decision stays refused
  // with "Resume sync first" otherwise) but must not connect, or the unconfirmed deletes
  // would sync. The hold keeps the queue and the reconciler gated on its own.
  host.syncManager?.resume();
  if (host.settings.massDeleteHold) return;
  host.statusBar?.clearOffline();
  startTransport(host);
}

function attachTransportListeners(host: SyncSessionHost, transport: Transport): void {
  transport.addEventListener("version", (event: Event) => {
    const pending = host.syncManager?.handleVersion((event as CustomEvent).detail);
    pending?.catch((error) => {
      log.error("failed to handle remote version", { error: formatError(error) });
    });
  });
  transport.addEventListener("status", (event: Event) => {
    host.statusBar?.updateState((event as CustomEvent).detail);
  });
  transport.addEventListener("reconnect", (event: Event) => {
    host.statusBar?.updateReconnectDelay((event as CustomEvent<number>).detail);
  });
  transport.addEventListener("live", () => {
    host.statusBar?.updateLastSync();
    // #342: retry pending folder re-includes whose catch-up failed earlier. A
    // missing sync manager is a failure (keeps pending), never a false success.
    void retryPendingCatchUp({
      settings: host.settings,
      saveSettings: () => host.saveSettings(),
      catchUpFolders: (folders) => {
        if (!host.syncManager) return Promise.reject(new Error("sync not started"));
        return host.syncManager.catchUpFolders(folders);
      },
    });
    host.syncManager?.flushVersionQueue()
      .then(async () => {
        try {
          await host.syncManager?.startReconciler();
        } finally {
          // The catch-up drain is durable here regardless: report the applied
          // position now (one small message per connection).
          scheduleAppliedSeqReport(host, true);
        }
      })
      .catch((error) => {
        log.error("failed to start reconciler after flush", { error: formatError(error) });
      });
  });
  transport.addEventListener("hello_ack", (event: Event) => {
    const detail = (event as CustomEvent).detail as {
      seq: number;
      vault_name?: string;
      server_version?: string;
      rekey?: boolean;
      verifier_hash?: string;
    };
    // #560: the re-key signal is decided before anything else: a paused or
    // locked device must not commit with keys the vault no longer uses.
    host.onHelloRekey(helloRekeyDecision(detail, host.settings.verifier));
    // #529: surface the server version first: the hint must show even when the
    // vault name already matches (the reconcileVaultName early return below).
    host.onServerVersion(detail.server_version ?? "");
    // Record the connection's replay end (the vault's max seq at handshake) and
    // reset the per-connection received state before the paced replay streams in.
    host.state?.beginReplay(detail.seq);
    const next = reconcileVaultName(host.settings.vaultName, detail.vault_name);
    if (next === null) return;
    host.onVaultNameResolved(next);
  });
  transport.addEventListener("blocked", (event: Event) => {
    const detail = (event as CustomEvent).detail as {
      server_version: string;
      client_version: string;
      reason: string;
    };
    host.onBlocked(detail.server_version, detail.client_version, detail.reason);
  });
}

function handlePassDone(
  host: SyncSessionHost,
  opts: { failed: boolean; drainDone: boolean; commitDone: boolean },
): void {
  const dirty = host.eventHandler?.getPendingOps().length ?? 0;
  const pending = host.syncManager?.getPendingOps().length ?? 0;
  host.statusBar?.updateDirty(dirty);
  // Only the replay drain's own completion clears the applying progress: a
  // commit pass ending mid-drain must not flash the green check (#523).
  if (opts.drainDone) {
    host.statusBar?.clearSyncingProgress();
    host.setSyncingProgress(null);
  }
  // #420: no green (or its hold) for a pass that didn't reach the server.
  if (!opts.failed) {
    host.statusBar?.updateLastSync();
    // ack only when no user work remains: green must not mask pending work.
    if (opts.commitDone && dirty === 0 && pending === 0) host.statusBar?.updateLastAck();
  }
  maybeStampBackup(host, dirty, pending);
}

/** #420: a clean sync cycle may stamp a backup; extracted to hold the
 * pass-done function under the complexity budget. */
function maybeStampBackup(host: SyncSessionHost, dirty: number, pending: number): void {
  const live = host.transport?.getState() === "live";
  const dropped = host.syncManager?.getDroppedCount() ?? 0;
  if (shouldStampBackup({ live, dirty, pending, dropped })) {
    host.onSyncCycleClean();
  }
}

/** #523/#420: attribute a "sync" status: a bare (or failed-marked) one is
 * the outbound commit pass; the replay marks its own drain-complete and
 * per-version applies; an idle pass (empty queue) is a clean cycle but not an
 * ack. Kept here to hold the session's status switch under the complexity
 * budget. */
function syncSource(data: unknown): { failed: boolean; drainDone: boolean; commitDone: boolean } {
  const d = data as
    | { failed?: boolean; drain?: boolean; apply?: boolean; idle?: boolean }
    | undefined;
  return {
    failed: d?.failed === true,
    drainDone: d?.drain === true,
    commitDone: d?.drain !== true && d?.apply !== true && d?.idle !== true,
  };
}

function handleSyncStatus(host: SyncSessionHost, status: string, data?: unknown): void {
  switch (status) {
    case "sync":
      handlePassDone(host, syncSource(data));
      // Apply/commit batch drained: coalesce the applied-position report.
      scheduleAppliedSeqReport(host, false);
      break;
    case "applying": {
      const progress = data as { current: number; total: number };
      host.statusBar?.updateSyncingProgress(progress.current, progress.total);
      host.setSyncingProgress(progress);
      break;
    }
    case "pending":
      host.statusBar?.updatePending(data as number);
      break;
    case "dropped":
      host.statusBar?.updateDropped(data as number);
      break;
    case "retries":
      host.statusBar?.updateRetries(data as number);
      break;
    case "conflict":
      host.statusBar?.updateConflicts(data as number);
      break;
  }
}

// ── Applied-position reporting (#433) ───────────────────────────────────────
// The server tracks each device's applied seq so other devices can show
// "N changes behind". Report the persisted sync cursor: immediately after a
// catch-up drain (go-live), and trailing-throttled on every apply/commit batch
// ("sync" status) so a long replay storm coalesces into one report after it
// settles, while a single commit lands within ~2 s.
let appliedSeqReportTimer: ReturnType<typeof setTimeout> | null = null;
let lastReportedAppliedSeq = 0;
const APPLIED_SEQ_REPORT_THROTTLE_MS = 2_000;

function scheduleAppliedSeqReport(host: SyncSessionHost, immediate: boolean): void {
  // State is always open when the transport is live; without it there is no
  // position to report (reporting 0 would clobber the stored position).
  const state = host.state;
  if (!state) return;
  if (immediate) {
    // One small report per (re)connect: the server's applied_seq is authoritative
    // for the Devices view, so always re-send this device's true position after
    // the catch-up drain (covers a server rebuild where the column was reset).
    if (appliedSeqReportTimer) clearTimeout(appliedSeqReportTimer);
    appliedSeqReportTimer = null;
    const cursor = state.getSyncCursor();
    lastReportedAppliedSeq = cursor;
    host.transport?.reportAppliedSeq(cursor);
    return;
  }
  if (appliedSeqReportTimer) return;
  appliedSeqReportTimer = setTimeout(() => {
    appliedSeqReportTimer = null;
    const cursor = state.getSyncCursor();
    if (cursor > lastReportedAppliedSeq) {
      lastReportedAppliedSeq = cursor;
      host.transport?.reportAppliedSeq(cursor);
    }
  }, APPLIED_SEQ_REPORT_THROTTLE_MS);
}
