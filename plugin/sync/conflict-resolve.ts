// #432: conflict resolution, obsidian-free. The planner is pure (what to
// write, delete, rename per action); the executor does the disk ops and commits
// through the normal commit path so other devices converge. The conflict file
// is attributed to its creator: on the creating device it holds this device's
// version (mine), on a device it arrived on it holds the other device's (so
// Keep mine / Keep theirs invert there). Only whole versions move; marker
// content is never written (hard rule 6). Every delete of a conflict file is a
// committed delete, because with syncing the server holds its head.

import { VaultKeys } from "../../core/crypto.ts";
import { commitOp, waitForInFlightCommit } from "./commit.ts";
import { keptConflictPath } from "./conflict-list.ts";
import { splitExt } from "./conflicts.ts";
import type { StateDB } from "../plumbing/state.ts";
import type { Transport } from "./transport.ts";

export type ResolutionAction = "keep-mine" | "keep-theirs" | "keep-both";

export interface ResolutionPlan {
  /** Write `source`'s whole content to `path`. */
  write?: { path: string; source: string };
  /** Delete this path (always the conflict file). */
  delete?: string;
  /** Move `from` to `to` (keep both). */
  rename?: { from: string; to: string };
}

export function planResolution(
  row: { path: string; conflictPath: string; conflictFileIsMine: boolean },
  action: ResolutionAction,
): ResolutionPlan {
  if (action === "keep-both") {
    return { rename: { from: row.conflictPath, to: keptConflictPath(row.path) } };
  }
  // keep-mine keeps the conflict file's content only when it is this device's;
  // keep-theirs keeps it when it arrived from another device (inversion).
  const keepConflict = (action === "keep-mine") === row.conflictFileIsMine;
  const plan: ResolutionPlan = { delete: row.conflictPath };
  if (keepConflict) plan.write = { path: row.path, source: row.conflictPath };
  return plan;
}

/** The kept-side label shared by the activity line and the notice. */
export function resolutionLabel(
  action: ResolutionAction,
  ownName: string,
  remoteName: string | null,
): string {
  if (action === "keep-both") return "kept both";
  const name = action === "keep-mine"
    ? (ownName.trim() || "This device")
    : (remoteName ?? "Another device");
  return `kept ${name}'s version`;
}

export interface ResolveDeps {
  vault: {
    adapter: {
      readBinary: (path: string) => Promise<Uint8Array>;
      writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) => Promise<void>;
      stat: (path: string) => Promise<{ size: number; mtime: number }>;
      remove: (path: string) => Promise<void>;
      exists: (path: string) => Promise<boolean>;
    };
  };
  state: StateDB;
  keys: VaultKeys;
  transport: Transport;
  onConflict: (
    path: string,
    serverHead: { path_hash: string; version: number },
  ) => Promise<void> | void;
  /** Clears the tracked conflict count once the conflict file is gone. */
  onConflictFileDeleted: (path: string) => void;
}

/** Returns the kept copy path for keep both, null otherwise. */
export async function executeResolution(
  plan: ResolutionPlan,
  deps: ResolveDeps,
): Promise<string | null> {
  let keptPath: string | null = null;
  if (plan.write) {
    const data = await deps.vault.adapter.readBinary(plan.write.source);
    await deps.vault.adapter.writeBinary(plan.write.path, data);
    await commitResolution({ path: plan.write.path, kind: "commit" }, deps);
  }
  if (plan.rename) {
    keptPath = await uniqueKeptPath(plan.rename.to, deps);
    const data = await deps.vault.adapter.readBinary(plan.rename.from);
    await deps.vault.adapter.writeBinary(keptPath, data);
    await deps.vault.adapter.remove(plan.rename.from);
    await commitResolution({ path: keptPath, kind: "commit" }, deps);
    // The conflict file may live on the server (conflict files sync); commit
    // its deletion so peers stop seeing it. A never-committed file has no
    // state row, and commitDelete is then a no-op.
    await commitResolution({ path: plan.rename.from, kind: "delete" }, deps);
    deps.onConflictFileDeleted(plan.rename.from);
  }
  if (plan.delete) {
    await deleteCommitted(plan.delete, deps);
  }
  return keptPath;
}

/** A resolution must reach the server; a failed commit throws so the modal's
 * catch shows an error Notice and reloads instead of "Resolved". First wait for
 * a same-path commit already in flight (the reconciler's first commit of the
 * fresh conflict file) so this commit is not silently dropped by commitOp's
 * dedup (#432). */
async function commitResolution(
  op: { path: string; kind: "commit" | "delete" },
  deps: ResolveDeps,
): Promise<void> {
  if (!(await waitForInFlightCommit(deps.state, op.path))) {
    throw new Error("still syncing this file. Try again in a moment.");
  }
  if (!(await commitOp(op, commitDeps(deps)))) {
    throw new Error(`failed to commit the resolution of ${op.path}`);
  }
}

/** Delete a path with a committed deletion (the server holds the head for any
 * file that ever synced, conflict files included after #432). */
async function deleteCommitted(path: string, deps: ResolveDeps): Promise<void> {
  await deps.vault.adapter.remove(path);
  await commitResolution({ path, kind: "delete" }, deps);
  deps.onConflictFileDeleted(path);
}

function commitDeps(deps: ResolveDeps) {
  return {
    vault: deps.vault,
    state: deps.state,
    keys: deps.keys,
    transport: deps.transport,
    onConflict: deps.onConflict,
    // A resolution writes a whole version under the file's own name; no rename of
    // this device is migrating under it.
    pendingRenameTarget: () => undefined,
  };
}

/** A kept copy beside an existing one gets a numbered suffix. */
async function uniqueKeptPath(desired: string, deps: ResolveDeps): Promise<string> {
  let to = desired;
  let n = 2;
  while (await deps.vault.adapter.exists(to)) {
    const { stem, ext } = splitExt(to);
    to = `${stem} ${n}${ext}`;
    n++;
  }
  return to;
}
