import { normalizePath } from "../../core/normalize.ts";
import { nextRenameId, type RenameLink } from "./commit.ts";

// Fixed pending-window: the first uncommitted edit opens a 2s window; further
// edits within it do NOT reset the timer, so a commit lands at most 2s after the
// first edit (hard real-time ceiling). A single edit then silence still commits
// at 2s: the cap subsumes any separate idle timer.
const PENDING_WINDOW_MS = 2_000;
const TRASH_CHECK_MS = 500;
// A suppression whose echo event never fires (no-op or removed write) must not
// swallow a later genuine edit; entries older than this are treated as stale.
const SELF_WRITE_TTL_MS = 3_000;

/** #697: the key of one applied rename: both paths, normalized as `handleRename` reads them. */
function selfRenameKey(from: string, to: string): string {
  return `${normalizePath(from)}\u0000${normalizePath(to)}`;
}

export interface PendingOp extends RenameLink {
  path: string;
  kind: "commit" | "delete";
  scheduledAt: number;
}

type Vault = {
  on: (name: string, callback: (...args: unknown[]) => void) => void;
  off: (name: string, callback: (...args: unknown[]) => void) => void;
  adapter: {
    exists?: (path: string) => Promise<boolean>;
  };
};

/** #584: a move that touches a folder excluded from sync (#342). The event layer only
 * reports it; the sync layer decides what it means for the parked file's history. */
export interface ScopeMoves {
  /** a synced file was moved into an excluded folder (no server delete yet) */
  movedOut: (oldPath: string, destPath: string) => void;
  /** it moved again, still out of scope: the parked destination follows it */
  movedInside: (from: string, to: string) => void;
  /** it is back in scope; true = a parked move was resolved and its link queued */
  movedBack: (from: string, to: string) => boolean;
  /** a parked file was deleted out of scope: it is gone for sync */
  deleted: (path: string) => void;
}

export class VaultEventHandler {
  private debouncers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingOps: Map<string, PendingOp> = new Map();
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private selfWritePaths = new Map<string, number>();
  /** #697: applied renames, keyed by their (old, new) pair; only the rename event reads it. */
  private selfRenames = new Map<string, number>();
  private trashCheckInFlight = new Set<string>();
  private onCreate = (...args: unknown[]) => this.handleCreate(args[0] as { path: string });
  private onModify = (...args: unknown[]) => this.handleModify(args[0] as { path: string });
  private onDelete = (...args: unknown[]) => this.handleDelete(args[0] as { path: string });
  private onRename = (...args: unknown[]) =>
    this.handleRename(
      args[0] as { path: string; children?: unknown[] },
      args[1] as string,
    );

  constructor(
    private vault: Vault,
    private onFlush: (ops: PendingOp[]) => void,
    private isSyncable: (path: string) => boolean,
    private onPendingCount?: (count: number) => void,
    /** #342/#584: moves across the scope boundary: a file moved into an excluded
     * folder is parked (no server delete) and linked when it resolves. */
    private scopeMoves?: ScopeMoves,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.vault.on("create", this.onCreate);
    this.vault.on("modify", this.onModify);
    this.vault.on("delete", this.onDelete);
    this.vault.on("rename", this.onRename);

    this.drainTimer = setInterval(() => this.flushPending(), 5_000);
  }

  stop(): void {
    this.isRunning = false;
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    for (const timer of this.debouncers.values()) clearTimeout(timer);
    this.debouncers.clear();
    this.vault.off("create", this.onCreate);
    this.vault.off("modify", this.onModify);
    this.vault.off("delete", this.onDelete);
    this.vault.off("rename", this.onRename);
  }

  flushNow(): void {
    for (const timer of this.debouncers.values()) clearTimeout(timer);
    this.debouncers.clear();
    this.flushPending();
  }

  suppressSelfWrite(path: string): void {
    this.selfWritePaths.set(path, Date.now());
  }

  /** #697: mark this device's own applied rename as the exact (old, new) pair, so its
   * `rename` event is not queued as a user's move. The returned function drops the mark
   * again: a rename that did not happen must not swallow one.
   *
   * A pair, not two path marks: an echo at either path (`create`/`modify`/`delete`, which
   * consume their own marks) must not open the door for the rename event. */
  suppressSelfRename(from: string, to: string): () => void {
    const key = selfRenameKey(from, to);
    this.selfRenames.set(key, Date.now());
    return () => this.selfRenames.delete(key);
  }

  private consumeSelfWrite(path: string): boolean {
    return this.takeMark(this.selfWritePaths, path);
  }

  /** #697: only the exact pair the apply registered is dropped: a user's own move of the
   * same file to another name in that window is queued as usual. */
  private consumeSelfRename(from: string, to: string): boolean {
    return this.takeMark(this.selfRenames, selfRenameKey(from, to));
  }

  /** Take a one-shot mark: true when it is there and still fresh. */
  private takeMark(marks: Map<string, number>, key: string): boolean {
    const markedAt = marks.get(key);
    if (markedAt === undefined) return false;
    marks.delete(key);
    return Date.now() - markedAt < SELF_WRITE_TTL_MS;
  }

  private handleCreate(file: { path: string }): void {
    if (Array.isArray((file as { children?: unknown[] }).children)) return;
    const path = normalizePath(file.path);
    if (this.consumeSelfWrite(path)) return;
    if (!this.isSyncable(path)) return;
    this.enqueueOp({ path, kind: "commit", scheduledAt: Date.now() });
  }

  private handleModify(file: { path: string }): void {
    if (Array.isArray((file as { children?: unknown[] }).children)) return;
    const path = normalizePath(file.path);
    if (this.consumeSelfWrite(path)) return;
    if (!this.isSyncable(path)) return;
    this.enqueueOp({ path, kind: "commit", scheduledAt: Date.now() });
  }

  private handleDelete(file: { path: string }): void {
    if (Array.isArray((file as { children?: unknown[] }).children)) return;
    const path = normalizePath(file.path);
    if (this.consumeSelfWrite(path)) return;
    if (!this.isSyncable(path)) {
      // #584: a parked file deleted inside its excluded folder is gone for sync.
      this.scopeMoves?.deleted(path);
      return;
    }
    this.enqueueOp({ path, kind: "delete", scheduledAt: Date.now() });
    this.checkTrashMove(path);
  }

  private checkTrashMove(originalPath: string): void {
    const trashPath = normalizePath(".trash/" + originalPath);
    if (!this.isSyncable(trashPath)) return;
    if (!this.vault.adapter.exists) return;
    if (this.trashCheckInFlight.has(trashPath)) return;
    if (this.pendingOps.has(trashPath)) return;

    this.trashCheckInFlight.add(trashPath);
    setTimeout(() => {
      void (async () => {
        this.trashCheckInFlight.delete(trashPath);
        try {
          if (await this.vault.adapter.exists!(trashPath)) {
            this.enqueueOp({ path: trashPath, kind: "commit", scheduledAt: Date.now() });
          }
        } catch {
          // adapter.exists failure is non-fatal
        }
      })();
    }, TRASH_CHECK_MS);
  }

  private handleRename(file: { path: string; children?: unknown[] }, oldPath: string): void {
    if (Array.isArray(file.children)) return;
    const newNorm = normalizePath(file.path);
    const oldNorm = normalizePath(oldPath);
    if (this.consumeSelfRename(oldNorm, newNorm)) return;
    const oldIn = this.isSyncable(oldNorm);
    const newIn = this.isSyncable(newNorm);

    if (oldIn && newIn) {
      // #583 (§9): a normalization-only change is not a rename: the path key is
      // the same, so neither a marker nor a delete may be written.
      if (oldNorm === newNorm) {
        this.enqueueOp({ path: newNorm, kind: "commit", scheduledAt: Date.now() });
        return;
      }
      const renameId = nextRenameId();
      this.enqueueOp({
        path: oldNorm,
        kind: "delete",
        scheduledAt: Date.now(),
        renameId,
        renamedTo: newNorm,
      });
      this.enqueueOp({
        path: newNorm,
        kind: "commit",
        scheduledAt: Date.now(),
        renameId,
        renamedFrom: oldNorm,
      });
    } else if (oldIn && !newIn) {
      // #342: moving into an excluded folder stops syncing; no server delete.
      // #584: the move is parked so the history can be joined when it resolves.
      this.scopeMoves?.movedOut(oldNorm, newNorm);
    } else if (!oldIn && newIn) {
      // #584: a parked file coming back is the second half of a rename: the sync layer
      // writes the marker + note instead of opening a fresh history at the new name.
      if (this.scopeMoves?.movedBack(oldNorm, newNorm)) return;
      // Moving back into scope: upload at the new path.
      this.enqueueOp({ path: newNorm, kind: "commit", scheduledAt: Date.now() });
    } else {
      // #584: a move inside the excluded area re-points the parked destination.
      this.scopeMoves?.movedInside(oldNorm, newNorm);
    }
  }

  private enqueueOp(op: PendingOp): void {
    const prev = this.pendingOps.get(op.path);
    if (prev?.renamedTo !== undefined && op.kind !== "delete") {
      // #583: the marker closing this name must land before the name is opened again
      // (one queued op per path would otherwise drop it).
      this.emit([prev]);
      this.pendingOps.delete(op.path);
      const timer = this.debouncers.get(op.path);
      if (timer) {
        clearTimeout(timer);
        this.debouncers.delete(op.path);
      }
    }
    // #583: a create/modify reported for the renamed path in the same window (mobile
    // delivers one) must not drop the note's link. #615: a marker closing a name a queued
    // note opened keeps the note's source: the hop is part of a rename chain.
    const linked = prev?.renamedFrom && !op.renamedFrom
      ? { ...op, renameId: prev.renameId, renamedFrom: prev.renamedFrom }
      : op;
    const isNewPath = !prev;
    // Always capture the latest op (a later kind flip, e.g. commit→delete,
    // supersedes), but never reset an already-open window.
    this.pendingOps.set(op.path, linked);
    if (isNewPath) this.onPendingCount?.(this.pendingOps.size);

    if (this.debouncers.has(op.path)) return;
    const timer = setTimeout(() => {
      this.debouncers.delete(op.path);
      this.flushPending();
    }, PENDING_WINDOW_MS);
    this.debouncers.set(op.path, timer);
  }

  private flushPending(): void {
    const readyOps: PendingOp[] = [];
    for (const [path, op] of this.pendingOps) {
      if (!this.debouncers.has(path)) {
        readyOps.push(op);
        this.pendingOps.delete(path);
      }
    }

    if (readyOps.length > 0) this.emit(readyOps);
  }

  /** #420: hand ops to the queue before reporting the count, so the icon never sees
   * 0 before the ack. */
  private emit(ops: PendingOp[]): void {
    this.onFlush(ops);
    this.onPendingCount?.(this.pendingOps.size);
  }

  getPendingOps(): PendingOp[] {
    return [...this.pendingOps.values()];
  }

  /** #593: a remote edit won over this path's delete while it is still inside its
   * debounce window: drop the op so it never reaches the commit queue. */
  cancelPendingDelete(path: string): void {
    const op = this.pendingOps.get(path);
    if (op?.kind !== "delete" || op.renamedTo !== undefined) return;
    this.pendingOps.delete(path);
    const timer = this.debouncers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debouncers.delete(path);
    }
    this.onPendingCount?.(this.pendingOps.size);
  }

  /** #583: the destination of a rename delete queued but not flushed yet. */
  renameTargetOf(path: string): string | undefined {
    const op = this.pendingOps.get(path);
    return op?.kind === "delete" ? op.renamedTo : undefined;
  }
}
