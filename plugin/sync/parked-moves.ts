// #342/#584: files renamed into an excluded folder: the row is tombstoned (no server
// delete while out of scope), the move is parked, and it closes as the rename it was once
// the destination comes back in scope.
import type { StateDB } from "../plumbing/state.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import {
  destFolderOf,
  type MoveOutUpdate,
  parkedMoveAt,
  parkMoveOut,
  type PendingMoveOut,
  pruneMoveOuts,
  repointMoveOut,
} from "../plumbing/scope-pending.ts";
import { existsOnDisk, nextRenameId } from "./commit.ts";
import type { PendingOp } from "./commit-queue.ts";

export interface ParkedMovesDeps {
  vault: { adapter: { stat: (path: string) => Promise<unknown | null> } };
  settings: PluginSettings;
  getState: () => StateDB | null;
  /** Persist the per-device settings (pendingMoveOuts lives there). */
  persist: () => Promise<void> | void;
  enqueue: (ops: PendingOp[], label: string) => Promise<void> | void;
}

export class ParkedMoves {
  constructor(private deps: ParkedMovesDeps) {}

  /** A file was moved into an excluded folder: tombstone its row (no server delete while
   * excluded) and park the move. #584: the parked entry keeps the exact destination, so
   * the move closes as the rename it was instead of splitting the file's history in two. */
  park(oldPath: string, destPath: string): void {
    const row = this.state?.getLocalFile(oldPath);
    if (!row || row.deleted) return;
    this.state?.upsertLocalFile({ ...row, deleted: true });
    this.apply(parkMoveOut(this.deps.settings.pendingMoveOuts, {
      oldPath,
      destPath,
      destFolder: destFolderOf(destPath),
    }));
  }

  /** #584: the parked file moved again inside the excluded area: its destination follows
   * it, so the link still names where it really is. */
  repoint(from: string, to: string): void {
    const next = repointMoveOut(this.deps.settings.pendingMoveOuts, from, to);
    if (next) this.apply(next);
  }

  /** #584: the parked file is back in scope: write the rename link now (the marker on the
   * parked name, the note on the destination) so its history stays one window. True =
   * handled, so the event layer writes no plain commit for the destination. */
  relink(from: string, to: string): boolean {
    const parked = this.parkedAt(from);
    if (!parked) return false;
    this.drop(parked);
    if (!this.nameIsClosed(parked)) return false;
    // A round trip (it came back under its own name) never left the name: its chain
    // continues where it was, so there is nothing to link.
    if (to === parked.oldPath) return false;
    this.link(parked, to);
    return true;
  }

  /** #584: the parked file was deleted inside its excluded folder: it is gone for sync, so
   * the parked name gets a plain tombstone (the trash keeps its history). */
  deleted(path: string): void {
    const parked = this.parkedAt(path);
    if (!parked) return;
    this.drop(parked);
    // The name was re-opened by a new file: the server's row there is not this file's, so
    // nothing is closed here: the reconciler owns that name now.
    if (!this.nameIsClosed(parked)) return;
    // Live again: a closed row reads as "this name is already closed" to the delete.
    this.releaseRow(parked.oldPath);
    void this.deps.enqueue(
      [{ path: parked.oldPath, kind: "delete" }],
      "#584 parked file deleted",
    );
  }

  /** #342: complete or bound the pendingMoveOuts list: a move completes once its
   * destination is back in scope, dead entries drop, the list stays capped. Runs after a
   * successful catch-up and on every reconciler start. Only a folder entry (`dir/`) can
   * cover a parked destination: the catch-up is also called with exact file paths. */
  async release(reIncluded: string[]): Promise<void> {
    const settings = this.deps.settings;
    const { completed, dropped } = pruneMoveOuts(settings.pendingMoveOuts, {
      excludedFolders: settings.excludedFolders,
      includedFolders: settings.includedFolders,
      pendingCatchUpFolders: settings.pendingCatchUpFolders,
      reIncludedFolders: reIncluded.filter((entry) => entry.endsWith("/")),
      hasRow: (oldPath) => this.state?.getLocalFile(oldPath) != null,
    });
    if (completed.length === 0 && dropped.length === 0) return;
    for (const m of completed) {
      // #584: the file is back in scope under the name it was parked at: link it. A file
      // that is gone from disk is not a move: release its row and let the reconciler
      // settle it (a same-content create still pairs as a rename, anything else is the
      // plain tombstone a deleted file owes).
      if (
        m.destPath && this.nameIsClosed(m) &&
        await existsOnDisk(m.destPath, this.deps.vault.adapter)
      ) {
        this.link(m, m.destPath);
        continue;
      }
      this.releaseRow(m.oldPath);
    }
    // Drop exactly what this pass settled, from the LIVE list: a park, re-point or relink
    // that landed during the awaits above must survive (and a resolved entry must not be
    // resurrected from the snapshot).
    const settled = new Set<PendingMoveOut>([...completed, ...dropped]);
    settings.pendingMoveOuts = settings.pendingMoveOuts.filter((m) => !settled.has(m));
    void this.deps.persist();
  }

  private apply(update: MoveOutUpdate): void {
    this.deps.settings.pendingMoveOuts = update.entries;
    // A file another park overwrote at its destination is gone from disk: close its name
    // with a plain tombstone (no link: nothing of it is left to follow), and release the
    // row so a lost op still leaves the reconciler a delete to propagate.
    for (const displaced of update.displaced) {
      if (!this.state?.getLocalFile(displaced.oldPath)) continue;
      this.releaseRow(displaced.oldPath);
      void this.deps.enqueue(
        [{ path: displaced.oldPath, kind: "delete" }],
        "#584 overwritten parked file closed",
      );
    }
    void this.deps.persist();
  }

  /** Un-tombstone a row: the name is this device's to settle again: the reconciler closes
   * it, or a queued rename's marker does. */
  private releaseRow(path: string): void {
    const row = this.state?.getLocalFile(path);
    if (row?.deleted) this.state?.upsertLocalFile({ ...row, deleted: false });
  }

  /** #584: the park can only be linked while its name is still the closed row the park
   * left behind. A new file at that name (or a version this device applied) means closing
   * it would tombstone a different file, so the park is simply dropped. */
  private nameIsClosed(parked: PendingMoveOut): boolean {
    return this.state?.getLocalFile(parked.oldPath)?.deleted === true;
  }

  private drop(parked: PendingMoveOut): void {
    this.deps.settings.pendingMoveOuts = this.deps.settings.pendingMoveOuts.filter((m) =>
      m !== parked
    );
    void this.deps.persist();
  }

  /** #584: resolve the park: the parked name closes with a marker and the destination
   * opens with its note (the pair an in-scope rename writes, resolved late). The row is
   * released first, so this is an ordinary rename in flight: a lost pair (restart, five
   * failed uploads) leaves a live row with no file, and the reconciler closes the name. */
  private link(parked: PendingMoveOut, destPath: string): void {
    this.releaseRow(parked.oldPath);
    const renameId = nextRenameId();
    void this.deps.enqueue([
      { path: parked.oldPath, kind: "delete", renameId, renamedTo: destPath },
      { path: destPath, kind: "commit", renameId, renamedFrom: parked.oldPath },
    ], "#584 parked move resolved");
  }

  private parkedAt(path: string): PendingMoveOut | undefined {
    return parkedMoveAt(this.deps.settings.pendingMoveOuts, path);
  }

  private get state(): StateDB | null {
    return this.deps.getState();
  }
}
