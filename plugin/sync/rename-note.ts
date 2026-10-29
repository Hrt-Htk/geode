// #583: the rename note a create carries (which older name it continues, and the cap its
// history link starts from), and the re-send that keeps that link when the commit lands on
// a closed name. Own module so the note rules are readable apart from the commit flow and
// commit.ts stays within the <=500 LOC tripwire.
import { RENAME_MARKER, RENAME_NOTE } from "../../core/protocol.ts";
import type { FileMeta } from "../../core/protocol.ts";
import { hashPathHex } from "../../core/hash.ts";
import type { LocalFileRow } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import type { CommitResult } from "./commit-channel.ts";
import { noteSource } from "./rename-chain.ts";
import type { CommitDeps } from "./commit.ts";

/** #583: a note whose commit collided with a *closed* name (a delete or an earlier
 * rename's marker) has nothing to merge: re-send it at the head so the link is not
 * lost in a merge commit. A collision with live content still goes to the merge. */
export async function resolveNoteConflict(
  result: CommitResult,
  mark: number | undefined,
  ctx: {
    pathHash: string;
    note: boolean;
    deps: CommitDeps;
    send: (parentVersion: number | null) => Promise<CommitResult>;
  },
): Promise<CommitResult> {
  if (result.kind !== "conflict" || !ctx.note || mark === undefined) return result;
  const head = (await ctx.deps.transport.getVersionChain(ctx.pathHash, result.parent_version))[0];
  if (!head?.deleted) return result;
  log.info("note re-sent over a closed name", { path_hash: ctx.pathHash, version: head.version });
  return await ctx.send(head.version);
}

/** #583: the note a create carries: only for the first version of a path with no
 * server history, and never when another device's marker already owns the old
 * name's history (decision 9: also after a restart lost the in-session record). */
export async function noteFor(
  path: string,
  renamedFrom: string | undefined,
  local: LocalFileRow | null,
  deps: CommitDeps,
): Promise<
  { fields: Pick<FileMeta, "renamed_from" | "renamed_from_version">; mark: number } | null
> {
  if (!renamedFrom) return null;
  // A live, already-tracked destination means this rename wrote over a file that was
  // there (a copy/reuse): it starts its own history. A *free* name: even one with
  // older server history: is opened by this rename, so it carries the note.
  if (local && !local.deleted && local.last_seen_version > 0) return null;
  if (deps.abandonedRenames?.delete(path)) return null;
  const source = noteSource(path, renamedFrom, deps.collapsedChains);
  if (source === null) return null;
  const oldHead = (await deps.transport.getVersionChain(
    hashPathHex(deps.keys.mac_key, source),
  ))[0];
  if (oldHead?.rename_mark === RENAME_MARKER && oldHead.device_id !== deps.deviceId) return null;
  // The cap is this rename's own marker: the source's head while it is our marker. A
  // pending marker leaves the source row on the previous generation, and capping the
  // note at *that* version points it below its marker, which reads as a missing link
  // (#583). 0 = "find the newest marker on the old path's head page".
  const ownMarker = oldHead?.rename_mark === RENAME_MARKER && oldHead.device_id === deps.deviceId;
  return {
    fields: {
      renamed_from: source,
      renamed_from_version: ownMarker ? oldHead.version : 0,
    },
    mark: RENAME_NOTE,
  };
}
