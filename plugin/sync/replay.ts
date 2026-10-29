import { ServerVersion } from "../../core/protocol.ts";
import { VaultKeys } from "../../core/crypto.ts";
import { StateDB } from "../plumbing/state.ts";
import { Transport, TransportState } from "./transport.ts";
import {
  ApplyDeps,
  applyVersion,
  carriedByMarker,
  keepVersionSibling,
  renameHeadOf,
} from "./apply.ts";
import { diskPlaintextHash, Vault } from "./vault-io.ts";
import { CoalescedEntry, coalesceReplay } from "./replay-coalesce.ts";
import type { ActivityRecord } from "./activity-log.ts";
import { log } from "../plumbing/log.ts";

// The inbound replay/apply pipeline: version serialization (versionQueue),
// replay buffering until live, interrupt handling, and the bounded version
// cache. SyncManager owns this and delegates its whole public surface here.
// Replay bugs #212, #283, #319, #369 all lived in these semantics.

export interface ReplayDeps {
  vault: Vault;
  transport: Transport;
  state: () => StateDB | null;
  keys: () => VaultKeys | null;
  deviceId: string;
  localEditPaths: Set<string>;
  hasLocalEdits: (path: string) => boolean;
  markLocalEdit: (path: string) => void;
  onConflict: (path: string, sv: ServerVersion) => Promise<void> | void;
  onStatusUpdate: (status: string, data?: unknown) => void;
  getSelfWriteSuppressor: () => ((path: string) => void) | null;
  /** #697: the pair marks of this device's own applied renames. */
  getSelfRenameSuppressor: () => ((from: string, to: string) => () => void) | null;
  /** #432: a conflict file deleted on another device clears this device's count. */
  onConflictFileDeleted?: (path: string) => void;
  /** #431: record downloads/applies and apply failures per file. */
  recordActivity?: ActivityRecord;
  /** #342: folder scope for remote applies. */
  isSyncable: (path: string) => boolean;
  /** #583: names the conflict file a renamed-away edit is kept in. */
  deviceName: string;
  /** #583: a pending rename of this device opens `path`: a peer's marker for the name
   * belongs to its previous generation. */
  isRenameTarget: (path: string) => boolean;
  /** #583: a pending rename delete for `path` (its destination). */
  pendingRenameTarget: (path: string) => string | undefined;
  /** #593: a plain delete of `path` this device has queued or still holds in the
   * event debounce. */
  hasPendingDelete: (path: string) => boolean;
  /** #593: an applied edit overrides that delete: cancel the pending op. */
  cancelPendingDelete: (path: string) => void;
  /** #584: the file at `path` is parked in an excluded folder on this device. */
  isParkedMove: (path: string) => boolean;
}

export class ReplayPipeline {
  static readonly VERSION_CACHE_MAX = 256;
  /** #583: parked versions are bounded like the version cache. Evicting the oldest
   * never loses content: its seq stays held, so the session cursor stays behind it and
   * the next reconnect re-delivers it. */
  static readonly DEFERRED_MAX = 64;
  private versionQueue = Promise.resolve();
  private replayBuffer: ServerVersion[] = [];
  /** #583: versions deferred by a pending rename, keyed per (path hash, seq): every
   * held seq must be released, and two versions of one path are two held seqs. */
  private deferredVersions = new Map<string, { msg: ServerVersion; destination: string }>();
  readonly versionCache = new Map<string, ServerVersion>();

  constructor(private deps: ReplayDeps) {
    // A disconnect mid-replay would otherwise leave the transport's in-memory
    // lastSeenSeq ahead of the persisted cursor; the buffered (not yet applied)
    // window would be skipped on the next reconnect (#117/#212). Rewind both
    // when we leave syncing without going live so the reconnect re-replays that tail.
    this.deps.transport.addEventListener("status", (e: Event) => {
      this.onReplayInterrupt((e as CustomEvent).detail as TransportState);
    });
  }

  async handleVersion(msg: ServerVersion): Promise<void> {
    log.debug("handleVersion", {
      seq: msg.seq,
      path_hash: msg.path_hash,
      version: msg.version,
      device_id: msg.device_id,
    });
    // The server streams seqs ascending and sends every existing one. Recording
    // receipt lets advanceSyncCursor treat a never-received, already-streamed-past
    // seq as a compaction gap instead of a stalled prefix (#369).
    this.deps.state()?.noteReceived(msg.seq);
    // The conflict path resolves head against the cache; keep it primed for every
    // msg regardless of whether it is applied now or buffered for replay flush.
    this.cacheVersion(msg);
    if (this.deps.transport.getState() === "syncing") {
      // Sync buffer synchronously: goLive() fires "live" right after the last
      // "version" event, so the final version must already be buffered here.
      this.replayBuffer.push(msg);
      return;
    }
    const run = this.versionQueue.then(async () => {
      const state = this.deps.state();
      const keys = this.deps.keys();
      if (!state || !keys) return;
      await applyVersion(msg, this.buildApplyDeps(state, keys));
      this.deps.onStatusUpdate("sync", { apply: true });
    });
    this.versionQueue = run.catch(() => {});
    await run;
  }

  // Drain the sync buffer on a coalesced flush. Ordering matters (#212): a path's
  // superseded seqs are advanced only AFTER its winner is durably applied, so a
  // failed winner apply can never leap-frog the persisted cursor past an un-applied
  // change.
  async flushReplayBuffer(): Promise<void> {
    const run = this.versionQueue.then(async () => {
      const state = this.deps.state();
      const keys = this.deps.keys();
      if (!state || !keys) return;
      const buffer = this.replayBuffer;
      this.replayBuffer = [];
      const deps = this.buildApplyDeps(state, keys);
      // Snapshot which paths already tracked a local edit. Applying only the winner
      // drops the intermediate versions whose skip-promote used to prime
      // hasLocalEdits so the final version merged. For a multi-version batch whose
      // winner freshly promotes a divergent disk edit, surface that merge here so a
      // replayed latest version conflicting with a local edit still merges/conflicts
      // instead of silently overwriting (#192/#283).
      const before = new Set(this.deps.localEditPaths);
      const entries = coalesceReplay(buffer);
      const total = entries.length;
      let applied = 0;
      const drainStart = performance.now();
      try {
        for (const entry of entries) {
          const row = state.getLocalFileByHash(entry.winner.path_hash);
          await this.promoteDeleteDivergence(entry, row, deps);
          try {
            await applyVersion(entry.winner, deps);
          } catch (err) {
            log.warn("flush apply failed, leaving winner for replay", {
              path: row?.path,
              path_hash: entry.winner.path_hash,
              seq: entry.winner.seq,
              error: err instanceof Error ? err.message : String(err),
            });
            if (row?.path) {
              this.deps.recordActivity?.({
                path: row.path,
                kind: "error",
                cause: err instanceof Error ? err.message : String(err),
              });
            }
            continue;
          }
          // Surface the apply backlog so the status icon shows "applying N/M"
          // instead of a false synced checkmark while the drain is in flight (#319).
          applied++;
          this.deps.onStatusUpdate("applying", { current: applied, total });
          await this.maybeSurfaceConflict(entry, row, before, deps);
          for (const seq of entry.supersededSeqs) {
            state.advanceSyncCursor(seq);
          }
        }
      } finally {
        // Always clear the in-flight progress so the icon returns to an honest
        // synced/offline state even if the drain body throws mid-way (#319).
        // #523: drain's own completion: the session clears applying progress only on this marker.
        this.deps.onStatusUpdate("sync", { drain: true });
        if (total > 0) {
          const totalMs = performance.now() - drainStart;
          log.info("replay drain timing", {
            files: applied,
            totalMs: Math.round(totalMs),
            filesPerSec: Math.round((applied / Math.max(totalMs, 1)) * 10_000) / 10,
          });
        }
      }
    });
    this.versionQueue = run.catch(() => {});
    await run.catch(() => {});
  }

  async flushVersionQueue(): Promise<void> {
    await this.versionQueue;
  }

  /** #583: re-apply the versions a pending rename deferred. Once no rename is queued
   * for the path, the marker either carried the version (the row is closed at/after it:
   * just advance) or the rename never landed: keep the peer's content as a conflict
   * sibling so neither edit is lost. */
  async retryDeferred(isRenamePending: (path: string) => boolean): Promise<void> {
    if (this.deferredVersions.size === 0) return;
    const run = this.versionQueue.then(async () => {
      const state = this.deps.state();
      const keys = this.deps.keys();
      if (!state || !keys) return;
      const deps = this.buildApplyDeps(state, keys);
      for (const [key, { msg, destination }] of [...this.deferredVersions]) {
        const row = state.getLocalFileByHash(msg.path_hash);
        if (row && isRenamePending(row.path)) continue;
        // A rename marker at/after the version carried it over; anything else (a plain
        // delete, a dropped op) never did, so keep both. A failed retry stays parked.
        try {
          if (!await carriedByMarker(msg, deps)) {
            await keepVersionSibling(msg, deps, destination);
          }
        } catch (error) {
          log.warn("deferred version retry failed, keeping it parked", {
            path_hash: msg.path_hash,
            seq: msg.seq,
            error: String(error),
          });
          continue;
        }
        this.deferredVersions.delete(key);
        state.advanceSyncCursor(msg.seq);
      }
    });
    this.versionQueue = run.catch(() => {});
    await run.catch(() => {});
  }

  /** #342: run scope catch-up applies through the same serialization as live
   * applies, so they can never interleave with a live apply for the same path. */
  enqueueApply(fn: () => Promise<void>): Promise<void> {
    const run = this.versionQueue.then(fn);
    this.versionQueue = run.catch(() => {});
    return run;
  }

  private async promoteDeleteDivergence(
    entry: CoalescedEntry,
    row: { path: string; deleted: boolean; plaintext_hash: string } | null,
    deps: ApplyDeps,
  ): Promise<void> {
    // A delete winner collapses a multi-version window to one shot; the
    // intermediate content versions that used to prime an untracked divergent
    // disk edit as a tracked local edit are gone, so applyDelete would remove
    // the file without ever inspecting the disk. Detect the divergence and
    // promote it before apply so the deleted branch routes to onConflict and
    // the local edit survives instead of being silently lost (#283).
    if (!entry.winner.deleted || entry.supersededSeqs.length === 0 || !row || row.deleted) return;
    const dh = await diskPlaintextHash(row.path, deps.vault);
    if (dh !== null && dh !== row.plaintext_hash) {
      deps.markLocalEdit(row.path);
    }
  }

  private async maybeSurfaceConflict(
    entry: CoalescedEntry,
    row: { path: string; deleted: boolean } | null,
    before: Set<string>,
    deps: ApplyDeps,
  ): Promise<void> {
    // Content winners defer the conflict to here (applyContent promotes the
    // divergent disk edit but does not conflict); delete winners already
    // routed to onConflict inside applyVersion, so skip them here to avoid
    // firing it twice.
    if (entry.winner.deleted || entry.supersededSeqs.length === 0 || !row) return;
    if (before.has(row.path) || !this.deps.localEditPaths.has(row.path)) return;
    await deps.onConflict(row.path, entry.winner);
  }

  buildApplyDeps(state: StateDB, keys: VaultKeys): ApplyDeps {
    return {
      vault: this.deps.vault,
      state,
      keys,
      getBlob: (hash: string) => this.deps.transport.getBlob(hash),
      hasLocalEdits: this.deps.hasLocalEdits,
      onConflict: this.deps.onConflict,
      markLocalEdit: this.deps.markLocalEdit,
      myDeviceId: this.deps.deviceId,
      suppressSelfWrite: this.deps.getSelfWriteSuppressor() ?? (() => {}),
      suppressSelfRename: this.deps.getSelfRenameSuppressor() ?? (() => () => {}),
      onConflictFileDeleted: this.deps.onConflictFileDeleted,
      recordActivity: this.deps.recordActivity,
      isSyncable: this.deps.isSyncable,
      deviceName: this.deps.deviceName,
      isRenameTarget: this.deps.isRenameTarget,
      pendingRenameTarget: this.deps.pendingRenameTarget,
      hasPendingDelete: this.deps.hasPendingDelete,
      cancelPendingDelete: this.deps.cancelPendingDelete,
      isParkedMove: this.deps.isParkedMove,
      renameHeadOf: (pathHash) => renameHeadOf(this.deps.transport, pathHash),
      parkDeferred: (msg, destination) => {
        const key = `${msg.path_hash}:${msg.seq}`;
        this.deferredVersions.set(key, { msg, destination });
        if (this.deferredVersions.size <= ReplayPipeline.DEFERRED_MAX) return;
        // Bounded like the version cache. The dropped version's seq stays held (it is
        // never advanced), so the session cursor stays behind it and the next reconnect
        // re-delivers its content.
        const oldestKey = this.deferredVersions.keys().next().value!;
        const dropped = this.deferredVersions.get(oldestKey)!;
        this.deferredVersions.delete(oldestKey);
        log.warn("deferred version dropped at the cap, its seq stays held", {
          path_hash: dropped.msg.path_hash,
          seq: dropped.msg.seq,
          parked: this.deferredVersions.size,
        });
      },
    };
  }

  private onReplayInterrupt(state: TransportState): void {
    if (state === "live" || state === "syncing") return;
    if (this.replayBuffer.length === 0) return;
    // Everything buffered is > the contiguous persisted cursor. Rewind the
    // in-memory cursor to the persisted one so the next reconnect re-requests
    // exactly the un-applied tail; re-applied versions are idempotently skipped.
    this.replayBuffer = [];
    const stateDB = this.deps.state();
    if (stateDB) {
      this.deps.transport.rewindLastSeen(stateDB.getSyncCursor());
    }
  }

  private cacheVersion(msg: ServerVersion): void {
    this.versionCache.set(`${msg.path_hash}:${msg.version}`, msg);
    if (this.versionCache.size > ReplayPipeline.VERSION_CACHE_MAX) {
      // Evict the oldest (insertion-ordered). Readers (handleConflict) fall back
      // to fetchHead on a miss, so eviction never breaks correctness.
      this.versionCache.delete(this.versionCache.keys().next().value!);
    }
  }
}
