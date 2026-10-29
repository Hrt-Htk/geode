import { VaultKeys } from "../../core/crypto.ts";
import { StateDB } from "../plumbing/state.ts";
import { Transport } from "./transport.ts";
import {
  CommitFileVanished,
  type CommitOp,
  commitOp,
  type RenameLink,
  type Vault,
} from "./commit.ts";
import {
  type CollapsedChain,
  collapseRenameChain,
  forgetChain,
  isRenameClose,
  linkChainTo,
  rememberChain,
} from "./rename-chain.ts";
import { isConflictPath } from "./conflicts.ts";
import type { ActivityRecord } from "./activity-log.ts";
import { log } from "../plumbing/log.ts";

export interface PendingOp extends RenameLink {
  path: string;
  kind: string;
  /** #583: the rename event that produced the link (the reconciler stamps none). */
  scheduledAt?: number;
}

export interface CommitQueueDeps {
  vault: Vault;
  getState: () => StateDB | null;
  getKeys: () => VaultKeys | null;
  getDeviceId?: () => string;
  getDeviceName?: () => string;
  /** #583: a carried rename edit must not enqueue a second rename. */
  suppressSelfWrite?: (path: string) => void;
  /** #697: pair marks of this device's own applied renames. */
  suppressSelfRename?: (from: string, to: string) => () => void;
  transport: Transport;
  onConflict: (
    path: string,
    serverHead: { path_hash: string; version: number },
  ) => Promise<void> | void;
  onStatusUpdate: (status: string, data?: unknown) => void;
  /** #583: called when a pass finishes: a version deferred by a pending rename can be
   * re-applied once that rename has settled (acked, dropped, or never queued). */
  onSettled?: () => void;
  onConflictFileDeleted: (path: string) => void;
  /** #431: own uploads/own deletes/commit errors per file. */
  recordActivity?: ActivityRecord;
  /** #595: a rename-away of this path this device has queued OR still holds in the
   * event debounce: a commit must never write into the name while it stands. */
  pendingRenameTarget: (path: string) => string | undefined;
}

/** #583: the pending op closes a renamed-away name and the new one opens it again: the
 * dedupe would drop the marker, so both are queued in order instead. */
function keepsMarkerBefore(op: PendingOp, prev: PendingOp): boolean {
  return prev.kind === "delete" && prev.renamedTo !== undefined && op.kind !== "delete";
}

/** #593: a plain delete of `path` (a rename's marker carries `renamedTo` and is not
 * one: cancelling it would lose the move). */
function isPlainDeleteOf(op: PendingOp | undefined, path: string): boolean {
  return op?.path === path && op.kind === "delete" && op.renamedTo === undefined;
}

/** #583: a superseding op for the same path (the reconciler's create can replace
 * the rename event's own op before it runs) keeps the link while it belongs to the
 * same rename: an op with no rename id of its own inherits the pending one. */
function withRenameLink(op: PendingOp, prev: PendingOp): PendingOp {
  if (op.renameId !== undefined && op.renameId !== prev.renameId) {
    // #615: a different rename closing the name a queued note opened ("... → Y → Z" in
    // one pass) keeps the note's source: the hop is part of a chain even though the two
    // ops belong to different renames.
    return op.kind === "delete" && prev.kind === "commit" && prev.renamedFrom &&
        op.renamedFrom === undefined
      ? { ...op, renamedFrom: prev.renamedFrom }
      : op;
  }
  const merged = { ...op, renameId: prev.renameId };
  return op.kind === "delete"
    ? { ...merged, renamedTo: op.renamedTo ?? prev.renamedTo }
    : { ...merged, renamedFrom: op.renamedFrom ?? prev.renamedFrom };
}

/**
 * Serial commit queue shared by the event flush, the reconciler and the
 * reconnect drain. Ops are merged into one ordered queue so a concurrent batch
 * never clobbers or clears ops it doesn't own; a failed op is requeued for the
 * next drain.
 */
export class CommitQueue {
  private pendingOps: PendingOp[] = [];
  private inFlightOp: PendingOp | null = null;
  private retryCounts = new Map<string, number>();
  private droppedOps = new Map<string, PendingOp>();
  private running: Promise<void> | null = null;
  private paused = false;
  /** #583: rename destinations whose history another device's marker owns. Per
   * queue, so it is vault-scoped and dies with the session (decision 9). */
  private readonly abandonedRenames = new Set<string>();
  /** #615: the middle names a collapsed rename chain skipped over, so the final note
   * can link past them. Per queue, bounded, dropped with the session. */
  private readonly collapsedChains = new Map<string, CollapsedChain>();
  private static readonly MAX_RETRIES = 5;

  constructor(private deps: CommitQueueDeps) {}

  getPendingOps(): PendingOp[] {
    return this.inFlightOp ? [...this.pendingOps, this.inFlightOp] : [...this.pendingOps];
  }

  /** #583: the destination of a pending rename delete for `path` (undefined if none). */
  renameTargetOf(path: string): string | undefined {
    return this.opsFor(path).find((o) => o.kind === "delete" && o.renamedTo)?.renamedTo;
  }

  /** #583: the source of a pending rename that will open `path` (undefined if none). A
   * marker also carries its hop's source (#615), but only a note opens the name. */
  renameSourceOf(path: string): string | undefined {
    return this.opsFor(path).find((o) => o.kind !== "delete" && o.renamedFrom)?.renamedFrom;
  }

  /** Every queued op for `path` (a rename marker and the op that opens the name again
   * can both be queued: the marker must land first). */
  private opsFor(path: string): PendingOp[] {
    return this.opsAll().filter((o) => o.path === path);
  }

  /** The in-flight op plus everything waiting: a chain's hops are all in here. */
  private opsAll(): PendingOp[] {
    return this.inFlightOp ? [this.inFlightOp, ...this.pendingOps] : [...this.pendingOps];
  }

  /** #615: a chain's links are resolved from the ops still queued: the marker names the
   * file's final name and remembers the hop, the note links past a middle name that never
   * writes a row. The resolved link stays on the op, so a retry sends the same one after
   * the hop's own op is gone. #629: a chain whose own destination is deleted before it
   * opens resolves to no link at all: one plain delete of the name it started from. */
  private resolveChain(op: PendingOp): PendingOp {
    const state = this.deps.getState();
    if (!state) return op;
    const deps = {
      state,
      pendingRenameTarget: this.deps.pendingRenameTarget,
      markerSource: this.markerSource,
      collapsedChains: this.collapsedChains,
      ownClose: this.renameCloseOf,
    };
    if (op.kind !== "delete") {
      if (op.renamedFrom === undefined) return op;
      const renamedFrom = linkChainTo(op.path, op.renamedFrom, deps);
      return renamedFrom === op.renamedFrom ? op : { ...op, renamedFrom };
    }
    if (op.renamedTo === undefined) return op;
    const to = collapseRenameChain(op.path, op.renamedTo, deps);
    if (to === null) return { ...op, renamedTo: undefined, renamedFrom: undefined };
    if (op.renamedFrom !== undefined && op.renamedFrom !== op.path) {
      const from = this.collapsedChains.get(op.renamedFrom)?.from ?? op.renamedFrom;
      if (from !== op.path) rememberChain(this.collapsedChains, op.path, from, to);
    }
    return to === op.renamedTo ? op : { ...op, renamedTo: to };
  }

  /** #615: the name a queued rename marker for `path` came from. */
  private markerSource = (path: string): string | undefined =>
    this.opsAll().find((o) =>
      o.kind === "delete" && o.path === path && o.renamedTo !== undefined && o.renamedFrom
    )?.renamedFrom;

  hasQueued(path: string): boolean {
    return this.pendingOps.some((o) => o.path === path) || this.inFlightOp?.path === path;
  }

  /** #593: a plain delete (not a rename's marker) of `path` is queued or in flight. */
  hasPendingDelete(path: string): boolean {
    return this.opsFor(path).some((o) => isPlainDeleteOf(o, path));
  }

  /** #629: a queued delete of `path` that superseded a rename's own note. */
  private renameCloseOf = (path: string): boolean => this.opsFor(path).some(isRenameClose);

  /** #593: an applied edit overrides this path's queued delete: drop it (and any
   * dropped record of it) so no tombstone goes out at the restored version's parent. */
  cancelPendingDelete(path: string): void {
    this.pendingOps = this.pendingOps.filter((o) => !isPlainDeleteOf(o, path));
    if (isPlainDeleteOf(this.droppedOps.get(path), path)) this.droppedOps.delete(path);
    this.deps.onStatusUpdate?.("pending", this.getPendingOps().length);
    this.emitDropped();
  }

  clearPending(): void {
    this.pendingOps = [];
    this.inFlightOp = null;
    this.droppedOps.clear();
    this.retryCounts.clear();
    this.abandonedRenames.clear();
    this.collapsedChains.clear();
    this.emitDropped();
    this.emitRetries();
  }

  getDroppedCount(): number {
    return this.droppedOps.size;
  }

  getMaxRetries(): number {
    let max = 0;
    for (const n of this.retryCounts.values()) if (n > max) max = n;
    return max;
  }

  retryDropped(): Promise<void> {
    if (this.droppedOps.size === 0) return Promise.resolve();
    const ops = [...this.droppedOps.values()];
    this.droppedOps.clear();
    this.emitDropped();
    return this.enqueue(ops, "retryDropped");
  }

  async enqueue(ops: PendingOp[], label: string): Promise<void> {
    for (const op of ops) {
      // The latest op per path wins. An op for the in-flight path cannot be
      // replaced (its commit already started): queue it to run after it.
      if (this.inFlightOp?.path === op.path) {
        this.pendingOps.push(op);
      } else {
        const i = this.pendingOps.findIndex((o) => o.path === op.path);
        if (i < 0) this.pendingOps.push(op);
        else if (keepsMarkerBefore(op, this.pendingOps[i])) this.pendingOps.splice(i + 1, 0, op);
        else this.pendingOps[i] = withRenameLink(op, this.pendingOps[i]);
      }
      this.retryCounts.delete(op.path); // a fresh intent resets the retry budget
      this.droppedOps.delete(op.path);
    }
    this.deps.onStatusUpdate?.("pending", this.getPendingOps().length);
    this.emitDropped();
    this.emitRetries();
    log.info(`${label} started`, {
      count: ops.length,
      transportState: this.deps.transport.getState(),
    });
    // Paused: hold the ops for the resume drain instead of uploading or dropping.
    if (!this.paused) await this.process();
  }

  /** While paused the queue accumulates ops and never processes; the resume drain flushes them. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  // Re-run the queue (e.g. after a reconnect) to retry requeued ops.
  drain(): Promise<void> {
    return this.process();
  }

  private emitDropped(): void {
    this.deps.onStatusUpdate?.("dropped", this.droppedOps.size);
  }

  private emitRetries(): void {
    this.deps.onStatusUpdate?.("retries", this.getMaxRetries());
  }

  // Callers await the in-flight pass, which drains ops enqueued mid-pass.
  private process(): Promise<void> {
    this.running ??= this.runPass();
    return this.running;
  }

  private async runPass(): Promise<void> {
    await null; // let process() record this pass before it can finish and clear itself
    const requeuedThisPass = new Set<string>();
    let processed = 0;
    try {
      while (this.pendingOps.length > 0) {
        if (this.paused) break; // a pause mid-pass holds the rest, no upload
        const ctx = this.unlocked();
        if (!ctx) break;
        const op = this.pickNextOp(requeuedThisPass);
        if (!op) break;
        processed++;
        await this.executeOp(op, ctx, requeuedThisPass);
      }
    } finally {
      this.running = null;
    }
    this.deps.onSettled?.();
    // empty pass = clean cycle, not an ack ({ idle }); requeued failures = { failed } (#420).
    if (!this.paused) {
      this.deps.onStatusUpdate?.(
        "sync",
        requeuedThisPass.size > 0 ? { failed: true } : processed === 0 ? { idle: true } : undefined,
      );
    }
  }

  // Not unlocked: nothing can commit, so drop the queue rather than leave
  // in-progress ops stuck.
  private unlocked(): { state: StateDB; keys: VaultKeys } | null {
    const state = this.deps.getState();
    const keys = this.deps.getKeys();
    if (!state || !keys) {
      this.pendingOps = [];
      this.inFlightOp = null;
      this.collapsedChains.clear();
      this.deps.onStatusUpdate?.("pending", 0);
      return null;
    }
    return { state, keys };
  }

  private pickNextOp(requeuedThisPass: Set<string>): PendingOp | null {
    const idx = this.pendingOps.findIndex(
      (o) => o.path !== this.inFlightOp?.path && !requeuedThisPass.has(o.path),
    );
    if (idx < 0) return null;
    const op = this.pendingOps[idx];
    this.pendingOps.splice(idx, 1);
    this.inFlightOp = op;
    this.deps.onStatusUpdate?.("pending", this.getPendingOps().length);
    return op;
  }

  private async executeOp(
    queued: PendingOp,
    ctx: { state: StateDB; keys: VaultKeys },
    requeuedThisPass: Set<string>,
  ): Promise<void> {
    let op = queued;
    try {
      op = this.resolveChain(queued);
      // Clear tracked conflict state when a conflict file is deleted.
      if (op.kind === "delete" && isConflictPath(op.path)) {
        this.deps.onConflictFileDeleted(op.path);
      }
      const ok = await commitOp(op as CommitOp, {
        vault: this.deps.vault,
        state: ctx.state,
        keys: ctx.keys,
        transport: this.deps.transport,
        onConflict: (path, head) => this.deps.onConflict(path, head),
        recordActivity: this.deps.recordActivity,
        deviceId: this.deps.getDeviceId?.(),
        deviceName: this.deps.getDeviceName?.(),
        suppressSelfWrite: this.deps.suppressSelfWrite,
        suppressSelfRename: this.deps.suppressSelfRename,
        abandonedRenames: this.abandonedRenames,
        pendingRenameTarget: this.deps.pendingRenameTarget,
        collapsedChains: this.collapsedChains,
      });
      if (ok) {
        this.retryCounts.delete(op.path);
        this.droppedOps.delete(op.path);
      } else {
        this.retryOrDrop(op, requeuedThisPass);
      }
    } catch (err) {
      log.warn("commit op failed", {
        path: op.path,
        error: err instanceof Error ? err.message : String(err),
      });
      // #589: the edit did not reach the server: a vanished file can never be
      // uploaded, so count it dropped; any other throw (a blob upload over a dead
      // socket, a transient adapter error) is retried, never reported as a lost edit
      // that blocks the backup stamp.
      if (err instanceof CommitFileVanished) this.dropOp(op);
      else this.retryOrDrop(op, requeuedThisPass);
      this.deps.recordActivity?.({
        path: op.path,
        kind: "error",
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlightOp = null;
      this.deps.onStatusUpdate?.("pending", this.getPendingOps().length);
      this.emitDropped();
      this.emitRetries();
    }
  }

  /** An op that can no longer be uploaded: counted as dropped (visible, and it
   * blocks the last-backup stamp) instead of disappearing. */
  private dropOp(op: PendingOp): void {
    this.retryCounts.delete(op.path);
    this.droppedOps.set(op.path, op);
    this.abandonedRenames.delete(op.path);
    forgetChain(this.collapsedChains, op.path);
  }

  private retryOrDrop(op: PendingOp, requeuedThisPass: Set<string>): void {
    // Retry only if no newer op for this path arrived while this one was in flight.
    if (this.pendingOps.some((o) => o.path === op.path)) return;
    const n = (this.retryCounts.get(op.path) ?? 0) + 1;
    if (n > CommitQueue.MAX_RETRIES) {
      this.dropOp(op);
      log.error("commit dropped after retry limit", { path: op.path, retries: n - 1 });
    } else {
      this.retryCounts.set(op.path, n);
      this.pendingOps.push(op);
      requeuedThisPass.add(op.path);
    }
    // executeOp's finally emits retries after this mutation: no emit here.
  }
}
