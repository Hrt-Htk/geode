import {
  b64decode,
  FileMeta,
  headToServerVersion,
  ServerVersion,
  type VersionRecord,
} from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";

import { StateDB } from "../plumbing/state.ts";
import { Transport } from "./transport.ts";
import { CommitQueue, type PendingOp } from "./commit-queue.ts";
import { ReplayPipeline } from "./replay.ts";
import { Reconciler } from "./reconciler.ts";
import { ConflictHandler } from "./conflict-handler.ts";
import { applyVersion, renameHeadOf } from "./apply.ts";
import { existsOnDisk } from "./commit.ts";
import { diskPlaintextHash } from "./vault-io.ts";
import { isParkedMove, isPathInCatchUp, isPendingScope } from "../plumbing/scope-pending.ts";
import { ParkedMoves } from "./parked-moves.ts";
import { isSyncable, PluginSettings } from "../plumbing/settings-types.ts";
import { log } from "../plumbing/log.ts";
import type { ActivityRecord } from "./activity-log.ts";
import {
  type HeldFile,
  holdOnTrip,
  MASS_DELETE_NEEDS_RESUME,
  type MassDeleteHold,
  planMassDeleteDecision,
} from "./mass-delete-hold.ts";
import { type RestoreOutcome, RestorePaused, restoreVersion } from "./history-restore.ts";

type Vault = {
  getAllLoadedFiles: () => Array<{ path: string }>;
  adapter: {
    readBinary: (path: string) => Promise<Uint8Array>;
    stat: (path: string) => Promise<{ size: number; mtime: number }>;
    writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) => Promise<void>;
    write: (path: string, data: string, opts?: { mtime?: number }) => Promise<void>;
    remove: (path: string) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
  };
};

export interface SyncManagerDeps {
  vault: Vault;
  settings: PluginSettings;
  configDir: string;
  /** #431: per-file activity recording (uploads, downloads, merges, deletes, conflicts, errors). */
  recordActivity?: ActivityRecord;
  /** #342: persist folder-scope pending state (settings live in per-device data.json). */
  persistScope?: () => Promise<void>;
  /** #601: reconnect from the persisted cursor, resolving on "live" (the session owns
   * the transport's credentials). A held list's decision needs the connection back. */
  reconnect: () => Promise<void>;
}

export class SyncManager {
  private state: StateDB | null = null;
  private keys: VaultKeys | null = null;
  private reconciler: Reconciler | null = null;
  private localEditPaths = new Set<string>();
  private onStatusUpdate: ((fn: string, data?: unknown) => void) | null = null;
  private onMassDeleteHoldChanged: ((hold: MassDeleteHold | null) => void) | null = null;
  private selfWriteSuppressor: ((path: string) => void) | null = null;
  private selfRenameSuppressor: ((from: string, to: string) => () => void) | null = null;
  private replay: ReplayPipeline;
  private conflictHandler: ConflictHandler;
  private commitQueue: CommitQueue;
  /** #342/#584: files parked in an excluded folder and their late rename links. */
  readonly parkedMoves: ParkedMoves;
  private paused = false;
  /** #601: a decision is being applied: the reconciler must not scan the half-settled
   * vault (a deferred start from the reconnect would re-trip the guard). */
  private deciding = false;
  /** #583: the events layer's un-flushed ops (the debounce window). */
  private pendingEventOps: () => PendingOp[] = () => [];
  /** #593: dropping one of those ops (the getter above cannot). */
  private cancelEventDelete: ((path: string) => void) | null = null;
  /** #465: lands the event layer's un-flushed edits before a restore. */
  private flushEdits: (() => void) | null = null;
  constructor(
    private transport: Transport,
    private deps: SyncManagerDeps,
  ) {
    this.replay = new ReplayPipeline({
      vault: deps.vault,
      transport,
      state: () => this.state,
      keys: () => this.keys,
      deviceId: deps.settings.deviceId,
      localEditPaths: this.localEditPaths,
      hasLocalEdits: (path) => this.hasLocalEdits(path),
      markLocalEdit: (path) => this.markLocalEdit(path),
      onConflict: (path, sv) => this.conflictHandler.handleConflict(path, sv),
      onStatusUpdate: (status, data) => this.onStatusUpdate?.(status, data),
      onConflictFileDeleted: (path) => this.conflictHandler.onConflictFileDeleted(path),
      getSelfWriteSuppressor: () => this.selfWriteSuppressor,
      getSelfRenameSuppressor: () => this.selfRenameSuppressor,
      recordActivity: deps.recordActivity,
      isSyncable: (path) => isSyncable(path, deps.configDir, deps.settings),
      deviceName: deps.settings.deviceName,
      isRenameTarget: (p) => this.renameSourceOf(p) !== undefined,
      pendingRenameTarget: (p) => this.renameTargetOf(p),
      isParkedMove: (p) => isParkedMove(deps.settings.pendingMoveOuts, p),
      hasPendingDelete: (p) => this.hasPendingDelete(p),
      cancelPendingDelete: (p) => this.cancelPendingDelete(p),
    });
    this.conflictHandler = new ConflictHandler({
      vault: deps.vault,
      vaultId: deps.settings.vaultId,
      getDeviceName: () => deps.settings.deviceName,
      deviceId: deps.settings.deviceId,
      transport,
      getState: () => this.state,
      getKeys: () => this.keys,
      onStatusUpdate: (status, data) => this.onStatusUpdate?.(status, data),
      versionCache: this.replay.versionCache,
      localEditPaths: this.localEditPaths,
      suppressSelfWrite: (p) => this.selfWriteSuppressor?.(p),
      suppressSelfRename: (from, to) => this.selfRenameSuppressor?.(from, to) ?? (() => {}),
      pendingRenameTarget: (p) => this.renameTargetOf(p),
      recordActivity: deps.recordActivity,
      files: () => deps.vault.getAllLoadedFiles(),
    });
    this.commitQueue = new CommitQueue({
      vault: deps.vault,
      getState: () => this.state,
      getKeys: () => this.keys,
      getDeviceId: () => deps.settings.deviceId,
      getDeviceName: () => deps.settings.deviceName,
      suppressSelfWrite: (p) => this.selfWriteSuppressor?.(p),
      suppressSelfRename: (from, to) => this.selfRenameSuppressor?.(from, to) ?? (() => {}),
      transport,
      onConflict: (path, head) => this.conflictHandler.handleConflict(path, head),
      onStatusUpdate: (status, data) => this.onStatusUpdate?.(status, data),
      onConflictFileDeleted: (path) => this.conflictHandler.onConflictFileDeleted(path),
      recordActivity: deps.recordActivity,
      pendingRenameTarget: (p) => this.renameTargetOf(p),
      onSettled: () => {
        void this.replay.retryDeferred((p) => this.renameTargetOf(p) !== undefined);
      },
    });
    this.parkedMoves = new ParkedMoves({
      vault: deps.vault,
      settings: deps.settings,
      getState: () => this.state,
      persist: () => deps.persistScope?.(),
      enqueue: (ops, label) => this.commitQueue.enqueue(ops, label),
    });
    // #601: a hold persisted by an earlier session gates this one from the start: the
    // session skips transport.start and announces the hold.
    this.setGate();
    // Drain the replay buffer when the replay ends. Subscribing here (rather than
    // relying on every wiring site) guarantees the buffer empties on "live" even
    // for reconnects that never call startReconciler.
    this.transport.addEventListener("live", () => {
      void this.replay.flushReplayBuffer();
      void this.commitQueue.drain();
    });
  }

  setState(state: StateDB, keys: VaultKeys): void {
    this.state = state;
    this.keys = keys;
  }

  clearState(): void {
    if (this.state) {
      this.state.close();
      this.state = null;
    }
    this.keys = null;
  }

  async startReconciler(): Promise<void> {
    // Paused, on hold, or mid-decision: nothing may scan the disk (a held pass would
    // re-trip the guard, and a mid-decision one would commit the paths being restored).
    if (this.paused || this.deciding || this.deps.settings.massDeleteHold) return;
    await this.replay.flushReplayBuffer();
    if (!this.state) return;
    // #342: bound pendingMoveOuts on every go-live: dead entries (source row
    // gone) drop, moves whose destination is back in scope complete, and the
    // list stays capped even for folders that are never re-included.
    await this.parkedMoves.release([]);
    // #622: a reconnect starts a fresh pass; the previous scanner must not keep
    // its own 5-minute interval alive.
    this.reconciler?.stop();
    this.reconciler = new Reconciler(
      this.deps.vault,
      this.state,
      (ops) => this.commitQueue.enqueue(ops, "handleReconcilerOps"),
      (path) => {
        const settings = this.deps.settings;
        // #342: a pending re-include is inert to the reconciler: its server
        // heads are still being fetched, so a local delete made while the folder
        // was excluded must not become a delete candidate yet.
        if (isPendingScope(path, settings, this.deps.configDir)) return false;
        return isSyncable(path, this.deps.configDir, settings);
      },
      this.deps.settings.syncObsidianConfig,
      {
        thresholds: () => ({
          minFiles: this.deps.settings.massDeleteMinFiles,
          minPercent: this.deps.settings.massDeleteMinPercent,
        }),
        onHold: (held, totalTracked) => this.enterMassDeleteHold(held, totalTracked),
      },
      this.deps.configDir,
      // #583: a name the server already closed as a rename is not a delete candidate.
      // Only ask while live: offline, or mid-replay, the head is not knowable anyway,
      // and the pass must not queue a chain fetch per missing path (mobile, 500 files).
      (pathHash) =>
        this.transport.getState() === "live"
          ? renameHeadOf(this.transport, pathHash)
          : Promise.resolve(null),
      // #583: a name whose rename this device already queued stays the event layer's
      // move: pairing it again would write a second marker for one rename.
      (path) => this.renameTargetOf(path),
      // #609: a name whose plain delete this device already queued is being deleted by
      // its own op: pairing it with a create of the same bytes would close it twice.
      (path) => this.hasPendingDelete(path),
    );
    this.reconciler.start();
  }

  stop(): void {
    this.transport.stop();
    this.reconciler?.stop();
  }

  reconcileNow(): Promise<void> {
    return this.reconciler?.run(true) ?? Promise.resolve();
  }

  setSyncObsidianConfig(value: boolean): void {
    this.reconciler?.setSyncObsidianConfig(value);
  }

  getPendingOps(): Array<{ path: string; kind: string }> {
    return this.commitQueue.getPendingOps();
  }

  getDroppedCount(): number {
    return this.commitQueue.getDroppedCount();
  }

  retryDropped(): Promise<void> {
    return this.commitQueue.retryDropped();
  }

  getConflictCount(): number {
    return this.conflictHandler.getConflictCount();
  }

  /** #432: resolution commits route commit conflicts back through the handler. */
  handleConflict(path: string, head: { path_hash: string; version: number }): Promise<void> {
    return this.conflictHandler.handleConflict(path, head);
  }

  /** #432: a resolved conflict file leaves the tracked count. */
  onConflictFileDeleted(path: string): void {
    this.conflictHandler.onConflictFileDeleted(path);
  }

  /** Lightweight stop: gate the commit queue and stop the reconciler. The session stops the transport. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.setGate();
    this.stopReconciler();
  }

  /** Re-enable the queue; the resume drain fires on "live", the reconciler restarts there too. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.setGate();
  }

  getMassDeleteHold(): MassDeleteHold | null {
    return this.deps.settings.massDeleteHold;
  }

  /** #601: the guard tripped: record the hold (a restart must land in the same state, not
   * sync the deletes), then stop the whole sync: uploads and downloads. */
  private async enterMassDeleteHold(held: HeldFile[], totalTracked: number): Promise<void> {
    const hold = holdOnTrip(this.deps.settings, held, totalTracked, Date.now());
    if (!hold) return;
    this.setGate();
    this.stopReconciler();
    this.transport.stop();
    await this.deps.persistScope?.();
    this.onMassDeleteHoldChanged?.(hold);
  }

  /** #601: apply a decision. The hold is released only once every path it keeps has been
   * verified on disk: releasing it with a path still missing would let the reconciler
   * commit that path as a delete. */
  async resolveMassDeleteHold(deletePaths: string[]): Promise<void> {
    const hold = this.deps.settings.massDeleteHold;
    if (!hold) return;
    if (this.paused) throw new Error(MASS_DELETE_NEEDS_RESUME);
    if (this.deciding) throw new Error("a mass delete decision is already in progress");
    this.deciding = true;
    let remove: string[];
    try {
      await this.deps.reconnect();
      if (!this.transport.isLive()) throw new Error("mass delete decision needs a live connection");
      await this.replay.flushVersionQueue();
      const exists = (path: string) => existsOnDisk(path, this.deps.vault.adapter);
      // A path the user excluded while the review window was open is no longer synced:
      // drop it from both sides, so it neither fails the restore check nor gets deleted.
      const scoped = hold.files.filter((f) =>
        isSyncable(f.path, this.deps.configDir, this.deps.settings)
      );
      const plan = await planMassDeleteDecision(scoped, deletePaths, exists);
      if (plan.restore.length > 0) await this.catchUpFolders(plan.restore);
      // catchUpFolders tolerates per-file failures, so re-plan: what is still missing is a
      // restore that did not land, and the decision must not go out on it.
      const unrestored = await planMassDeleteDecision(scoped, deletePaths, exists);
      if (unrestored.restore.length > 0) {
        throw new Error(
          `mass delete restore failed for ${unrestored.restore.length} file(s): ${
            unrestored.restore.join(", ")
          }`,
        );
      }
      this.deps.settings.massDeleteHold = null;
      await this.deps.persistScope?.();
      this.setGate();
      this.onMassDeleteHoldChanged?.(null);
      remove = unrestored.remove;
    } finally {
      this.deciding = false;
    }
    if (remove.length > 0) {
      await this.commitQueue.enqueue(
        remove.map((path) => ({ path, kind: "delete" })),
        "#601 confirmed mass delete",
      );
    }
    await this.startReconciler();
  }

  private setGate(): void {
    this.commitQueue.setPaused(this.paused || this.deps.settings.massDeleteHold !== null);
  }

  private stopReconciler(): void {
    this.reconciler?.stop();
    this.reconciler = null;
  }

  clearPending(): void {
    this.commitQueue.clearPending();
  }

  setOnStatusUpdate(fn: (status: string, data?: unknown) => void): void {
    this.onStatusUpdate = fn;
  }

  /** #601: the held list changed (tripped, or cleared by a decision). */
  setOnMassDeleteHoldChanged(fn: (hold: MassDeleteHold | null) => void): void {
    this.onMassDeleteHoldChanged = fn;
  }

  setSelfWriteSuppressor(fn: (path: string) => void): void {
    this.selfWriteSuppressor = fn;
  }

  /** #697: the pair marks of this device's own applied renames. */
  setSelfRenameSuppressor(fn: (from: string, to: string) => () => void): void {
    this.selfRenameSuppressor = fn;
  }

  /** #583: an inbound version must neither be applied over an edit the event layer
   * has queued nor merged into a name it is renaming: expose those ops here. */
  setPendingEventOps(fn: () => PendingOp[]): void {
    this.pendingEventOps = fn;
  }

  /** #593: an applied edit drops a delete still inside the event debounce. */
  setPendingDeleteCanceller(fn: (path: string) => void): void {
    this.cancelEventDelete = fn;
  }

  /** #465: an edit still inside the event debounce would commit AFTER a restore
   * and clobber it back: let the restore land those ops first. */
  setEditFlusher(fn: () => void): void {
    this.flushEdits = fn;
  }

  /** #465: restore a past version as a NEW head version at the file's current
   * name (append only: the content it replaces stays a version). */
  async restoreVersion(record: VersionRecord, path: string): Promise<RestoreOutcome> {
    const state = this.state;
    const keys = this.keys;
    if (!state || !keys) throw new Error("sync is not running");
    if (this.paused) throw new RestorePaused(path);
    this.flushEdits?.();
    await this.commitQueue.drain();
    return await restoreVersion(record, path, {
      vault: this.deps.vault,
      state,
      keys,
      transport: this.transport,
      onConflict: (p, head) => this.conflictHandler.handleConflict(p, head),
      recordActivity: this.deps.recordActivity,
      deviceId: this.deps.settings.deviceId,
      deviceName: this.deps.settings.deviceName,
      suppressSelfWrite: (p) => this.selfWriteSuppressor?.(p),
      suppressSelfRename: (from, to) => this.selfRenameSuppressor?.(from, to) ?? (() => {}),
    });
  }

  handleVersion(msg: ServerVersion): Promise<void> {
    return this.replay.handleVersion(msg);
  }

  /** #342: a folder was switched back on: apply the server's current heads for
   * paths under `folders` (normalized, trailing slash). Local edits made while
   * excluded are reconciled through the normal apply/merge path; files deleted
   * locally while excluded are restored from their heads (force). A file dropped
   * into the folder while excluded that also has a server head is surfaced as a
   * conflict so neither side is lost. A head that can't be applied is recorded
   * as a per-file error; catch-up succeeds once every other in-scope file
   * converged (pending clears), and throws only when nothing converged so the
   * caller keeps the folder pending and the next reconnect retries. */
  async catchUpFolders(folders: string[]): Promise<void> {
    const state = this.state;
    const keys = this.keys;
    if (!state || !keys) throw new Error("scope catch up skipped: state or keys missing");
    if (folders.length === 0) return;
    const deps = this.replay.buildApplyDeps(state, keys);
    const failures: Array<{ path: string; error: string }> = [];
    let inScope = 0;
    let inScopeFailures = 0;
    for await (const head of this.transport.getHeads(0)) {
      let meta: FileMeta;
      try {
        meta = await decryptMetadata(b64decode(head.enc_metadata), keys, head.path_hash);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ path: head.path_hash, error });
        continue;
      }
      if (!isPathInCatchUp(meta.path, folders, this.deps.configDir)) continue;
      inScope++;
      try {
        await this.replay.enqueueApply(async () => {
          // A tracked row whose file is missing (deleted locally while excluded)
          // must be restored from the head, not treated as a local delete; force
          // the head through even if already processed or self-authored. A row
          // with no tracked version applies normally.
          const row = state.getLocalFileByHash(head.path_hash);
          if (row === null) {
            // Untracked path with a present disk file (dropped into the folder
            // while excluded) and a divergent server head: mark it as a local
            // edit so applyVersion routes it through the conflict/merge path and
            // neither side is lost. Only a missing disk file is force-restored.
            const dh = await diskPlaintextHash(meta.path, deps.vault);
            if (dh !== null && dh !== meta.plaintext_hash) deps.markLocalEdit(meta.path);
            await applyVersion(headToServerVersion(head, this.deps.settings.vaultId), {
              ...deps,
              force: dh === null,
            });
            return;
          }
          const force = !row.deleted && (await diskPlaintextHash(row.path, deps.vault)) === null;
          await applyVersion(headToServerVersion(head, this.deps.settings.vaultId), {
            ...deps,
            force,
          });
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        inScopeFailures++;
        failures.push({ path: meta.path, error });
      }
    }
    if (failures.length > 0) {
      for (const f of failures) {
        this.deps.recordActivity?.({ path: f.path, kind: "error", cause: f.error });
      }
      log.warn("scope catch up had per-file failures", {
        failures: failures.map((f) => f.path),
      });
      // Clear pending once every other in-scope file converged; a folder whose
      // heads all failed (or can't even be decrypted) stays pending for retry.
      if (inScope - inScopeFailures <= 0) {
        throw new Error(
          `scope catch up failed for ${failures.length} file(s): ${
            failures.map((f) => f.path).join(", ")
          }`,
        );
      }
    }
    await this.parkedMoves.release(folders);
  }

  flushReplayBuffer(): Promise<void> {
    return this.replay.flushReplayBuffer();
  }

  flushVersionQueue(): Promise<void> {
    return this.replay.flushVersionQueue();
  }

  async handlePendingOps(ops: PendingOp[]): Promise<void> {
    await this.commitQueue.enqueue(ops, "handlePendingOps");
  }

  private hasLocalEdits(path: string): boolean {
    return this.commitQueue.hasQueued(path) || this.localEditPaths.has(path);
  }

  private renameSourceOf(path: string): string | undefined {
    return this.commitQueue.renameSourceOf(path) ??
      this.pendingEventOps().find((o) => o.path === path && o.kind !== "delete" && o.renamedFrom)
        ?.renamedFrom;
  }

  private renameTargetOf(path: string): string | undefined {
    return this.commitQueue.renameTargetOf(path) ??
      this.pendingEventOps().find((o) => o.path === path && o.kind === "delete")?.renamedTo;
  }

  /** #593: a plain delete of `path` this device has not pushed yet: queued, or still in
   * the event debounce (where only the event layer knows about it). A rename's marker is
   * not a plain delete. */
  private hasPendingDelete(path: string): boolean {
    return this.commitQueue.hasPendingDelete(path) ||
      this.pendingEventOps().some((o) => o.path === path && o.kind === "delete" && !o.renamedTo);
  }

  /** #593: the edit won: drop the delete from both layers so no tombstone follows the
   * restored version (a config path is not in the vault index, so commit.ts's #498
   * "file is back" guard cannot cancel it). */
  private cancelPendingDelete(path: string): void {
    this.commitQueue.cancelPendingDelete(path);
    this.cancelEventDelete?.(path);
  }

  markLocalEdit(path: string): void {
    this.localEditPaths.add(path);
  }

  clearLocalEdit(path: string): void {
    this.localEditPaths.delete(path);
  }
}
