import {
  b64decode,
  FileMeta,
  RENAME_MARKER,
  ServerVersion,
  type VersionRecord,
} from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { reassemble } from "../../core/reassemble.ts";
import { hashPathHex } from "../../core/hash.ts";
import { type LocalFileRow, StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import type { ActivityRecord } from "./activity-log.ts";
import {
  diskPlaintextHash,
  diskPlaintextHashIfPresent,
  removeVaultPath,
  renameableFile,
  type Vault,
  writeVaultBinary,
} from "./vault-io.ts";
import { carryLocalEdit, dropOldSpelling, followRename, freeConflictPath } from "./rename-carry.ts";

export interface ApplyDeps {
  vault: Vault;
  state: StateDB;
  keys: VaultKeys;
  getBlob: (hash: string) => Promise<Uint8Array>;
  hasLocalEdits: (path: string) => boolean;
  onConflict: (path: string, serverVersion: ServerVersion) => Promise<void> | void;
  markLocalEdit: (path: string) => void;
  myDeviceId: string;
  suppressSelfWrite: (path: string) => void;
  /** #697: mark this device's own applied rename as the (old, new) pair; the returned
   * function clears the mark when the rename did not happen. */
  suppressSelfRename?: (from: string, to: string) => () => void;
  /** #432: a conflict file deleted on another device clears this device's count. */
  onConflictFileDeleted?: (path: string) => void;
  /** #431: record downloads (remote applies) and remote deletes per file. */
  recordActivity?: ActivityRecord;
  /** #342: folder scope; out-of-scope versions are skipped (cursor still advances). */
  isSyncable?: (path: string) => boolean;
  /** #583: names a conflict file kept next to a renamed file. */
  deviceName?: string;
  /** #583: a closed destination is only reusable when the server has no marker on
   * it (a marker means it was renamed away again: writing there would loop). */
  renameHeadOf?: (
    pathHash: string,
  ) => Promise<{ version: number; deleted: number; rename_mark?: number } | null>;
  /** #583: a pending rename of this device opens the path: an incoming marker for
   * the name belongs to its previous generation, so nothing is carried over it. */
  isRenameTarget?: (path: string) => boolean;
  /** #583: the destination of a rename delete this device is closing: its content
   * belongs at that destination, not back under the old name. */
  pendingRenameTarget: (path: string) => string | undefined;
  /** #583: park a version deferred by a pending rename so it is re-applied (as a
   * conflict sibling, or skipped when the marker carried it) once that rename settles.
   * The cursor is deliberately NOT advanced: the version is still owed. */
  parkDeferred?: (msg: ServerVersion, destination: string) => void;
  /** #593: a plain delete of `path` this device has queued or still holds in the
   * event debounce (a rename's marker is not a plain delete: it is handled above). */
  hasPendingDelete?: (path: string) => boolean;
  /** #593: the edit won over that delete: drop the pending op (commit queue and the
   * event layer's un-flushed one) so no tombstone follows the restored version. */
  cancelPendingDelete?: (path: string) => void;
  /** #342: scope catch-up: apply even an already-processed or self-authored head
   * so a file deleted locally while the folder was excluded is restored from the
   * server. Never regresses below the already-tracked version. */
  force?: boolean;
  /** #584: this device parked the file in an excluded folder: the parked name's
   * versions are out of scope until the move resolves, and resolving it carries the
   * peer's edit over (the marker's conflict path). Never written back under the name. */
  isParkedMove?: (path: string) => boolean;
  /** #701: are bytes that diverge from this device's state its own edit (default) or a
   * copy the server cannot vouch for? False (a rejoin over an old copy) means the bytes
   * are already set aside and the server version wins, a delete included. */
  trustDiskDivergence?: (path: string) => boolean;
  /** #701 review: this caller applies versions in parallel (a rebuild's head loop), so
   * the disk can change between the divergence check and the write: re-read before
   * writing and keep bytes that arrived in between. A live session applies serially. */
  recheckDiskBeforeWrite?: boolean;
}

/** #701: whether divergent bytes on disk are this device's own edit. */
function trustsDivergentDisk(path: string, deps: ApplyDeps): boolean {
  return deps.trustDiskDivergence?.(path) ?? true;
}

/** A skipped version still owes the disk a look: bytes that diverged from the row are an
 * untracked local edit, promoted to tracked so the reconciler can commit it. */
async function promoteDivergentDisk(row: LocalFileRow, deps: ApplyDeps): Promise<void> {
  if (row.deleted) return;
  const dh = await diskPlaintextHash(row.path, deps.vault);
  if (dh === null || dh === row.plaintext_hash) return;
  if (!trustsDivergentDisk(row.path, deps)) return;
  deps.markLocalEdit(row.path);
  deps.state.upsertLocalFile({ ...row, deleted: false });
}

/** True when `msg` is at or past the version already tracked locally. In force
 * mode (scope catch-up) only a strictly older version counts, so an equal one
 * re-applies and restores a file that is missing on disk. */
function atOrPastTracked(
  msg: ServerVersion,
  existing: LocalFileRow,
  force: boolean | undefined,
): boolean {
  return force
    ? msg.version < existing.last_seen_version
    : msg.version <= existing.last_seen_version;
}

/** On (re)connect the server replays our own commits: rebuild local file state from
 * the replayed metadata so the reconciler has a baseline and the next edit commits
 * with the correct parent_version. Never write to disk (the file is already local). */
async function applyOwnVersion(msg: ServerVersion, deps: ApplyDeps): Promise<void> {
  const existing = deps.state.getLocalFileByHash(msg.path_hash);
  if (existing && msg.version <= existing.last_seen_version) {
    log.debug("apply skipped (own version)", { version: msg.version });
    deps.state.advanceSyncCursor(msg.seq);
    return;
  }
  const meta = await decryptMetadata(b64decode(msg.enc_metadata), deps.keys, msg.path_hash);
  deps.state.upsertLocalFile({
    path: meta.path,
    path_hash: msg.path_hash,
    size: meta.size,
    mtime: meta.mtime,
    plaintext_hash: meta.plaintext_hash,
    last_seen_version: msg.version,
    chunk_hashes: msg.chunk_hashes,
    deleted: msg.deleted,
  });
  log.debug("apply own version", { path: meta.path, version: msg.version });
  deps.state.advanceSyncCursor(msg.seq);
}

export async function applyVersion(msg: ServerVersion, deps: ApplyDeps): Promise<void> {
  // #687: a restore is credited to the device that asked for it, so that device
  // receives a version it authored. It is applied like any remote version (the trash
  // took the file off disk); every other own version is skipped.
  if (!deps.force && msg.device_id === deps.myDeviceId && msg.restored !== true) {
    return await applyOwnVersion(msg, deps);
  }

  // Skip versions we've already processed. After a restart the sync cursor may
  // be behind, causing the server to replay older versions. If our state already
  // tracks a version >= the incoming one, we've already accounted for this change.
  // In force mode (scope catch-up) only a strictly older version is skipped: an
  // equal version re-applies so a missing file is restored from the head.
  const existingByHash = deps.state.getLocalFileByHash(msg.path_hash);
  if (existingByHash && atOrPastTracked(msg, existingByHash, deps.force)) {
    // Check for untracked local edits before skipping: disk may have diverged
    // from the stored state (e.g. offline edit made after last sync).
    await promoteDivergentDisk(existingByHash, deps);
    await keepOvertakenContent(msg, existingByHash, deps);
    log.debug("apply skipped (already processed)", { version: msg.version });
    deps.state.advanceSyncCursor(msg.seq);
    return;
  }

  const meta = await decryptMetadata(
    b64decode(msg.enc_metadata),
    deps.keys,
    msg.path_hash,
  );

  if (skipsApply(meta.path, msg, deps)) return;

  // #613: the note left a name this device's carried edit is waiting on: the edit
  // moves to the note's new home instead of being stranded at the abandoned name.
  if (meta.renamed_from !== undefined) {
    await followCarriedEdit(meta.renamed_from, meta.path, deps);
  }

  if (msg.deleted) {
    // #583: a marker is a move, not a deletion: never route it through the
    // delete/modify conflict path (that path resurrects the old name, #361).
    if (msg.rename_mark === RENAME_MARKER) {
      return await applyRenameMarker(msg, deps, meta, existingByHash);
    }
    // #589: an edit still inside the event debounce is not in the commit queue
    // yet, so disk divergence is what sees it: the delete must conflict (local
    // wins, #361) instead of removing the only copy.
    if (await hasPendingEdit(meta.path, existingByHash, deps)) {
      await conflictNow(meta.path, msg, deps);
      return;
    }
    await applyDelete(msg, deps, meta);
    return;
  }

  if (await applyContentOrConflict(msg, deps, meta)) return;
  await applyContent(msg, deps, meta);
}

/** #593: a content version landing on a path this device is deleting. Delete-vs-edit
 * per #361: the version carries exactly what the user deleted ⇒ nothing new would be
 * lost, so the delete stands; anything else ⇒ the edit is kept and the override is
 * recorded so the user's delete is never undone without trace. */
async function applyOverPendingDelete(
  msg: ServerVersion,
  deps: ApplyDeps,
  meta: FileMeta,
  row: LocalFileRow | null,
): Promise<void> {
  if (row && !row.deleted && row.plaintext_hash === meta.plaintext_hash) {
    // The row takes the head version instead of closing: the queued delete op then
    // tombstones it, where a closed row would make commitDelete a no-op and leave this
    // copy on the server while the file is gone here.
    deps.state.upsertLocalFile({ ...row, last_seen_version: msg.version });
    deps.state.advanceSyncCursor(msg.seq);
    log.info("pending delete stands over an identical version", {
      path: meta.path,
      version: msg.version,
    });
    return;
  }
  await applyContent(msg, deps, meta);
  // #593: the edit wins, so the queued delete must go: for a path the vault index never
  // holds (a config file written through the adapter fallback) commit.ts's #498 guard
  // cannot cancel it, and its tombstone would land at the restored version's parent,
  // the peer deletes, this device re-uploads (a flap).
  deps.cancelPendingDelete?.(meta.path);
  deps.recordActivity?.({ path: meta.path, kind: "restored", deviceId: msg.device_id });
}

/** #583 (decision 2): a marker means the file moved. A pending local edit under the
 * old name (queued, or made while the app was closed) follows the note to the new
 * name and merges there; with nothing pending the old name closes as before (§4). */
async function applyRenameMarker(
  msg: ServerVersion,
  deps: ApplyDeps,
  meta: FileMeta,
  row: LocalFileRow | null,
): Promise<void> {
  if (deps.isRenameTarget?.(meta.path)) {
    // This device's own rename opens this name; the marker closes the generation the
    // name had before, and our queued commit follows with the note.
    deps.state.closeLocalRow(meta.path, msg.path_hash, msg.version);
    deps.state.advanceSyncCursor(msg.seq);
    log.info("marker closes the previous generation of a name we are opening", { path: meta.path });
    return;
  }
  const carried = await carryLocalEdit(
    {
      path: meta.path,
      renamedTo: meta.renamed_to,
      pendingEdit: await hasPendingEdit(meta.path, row, deps),
    },
    deps,
  );
  // The old name is empty by now (the carry moved the bytes or kept them next to the
  // new name in a conflict sibling): close its row and record the removal exactly as a
  // plain delete would.
  if (carried.kind === "kept") {
    // The edit was kept next to the new name (the renamed-away name stays empty, #583):
    // mark that file so a state rebuild never prunes it: the session commits it as
    // its own file.
    deps.markLocalEdit(carried.conflictPath);
    closeName(meta.path, msg, deps);
    log.info("renamed-away name closed, edit kept as a sibling", {
      path: meta.path,
      to: meta.renamed_to,
      conflictPath: carried.conflictPath,
    });
    return;
  }
  if (carried.kind === "moved") {
    // The carry moved the bytes itself (a vault rename, or a write and a removal): the old
    // name is already empty, so only its bookkeeping is left. A second removal of a path the
    // rename took is what tears a live editor down on Android (#697).
    closeName(meta.path, msg, deps);
    deps.markLocalEdit(carried.to);
    // The note's create lands next (or is already on the server): resolve it here so the
    // edit merges at the new name instead of waiting for the next reconcile. version 0,
    // the handler resolves the live head of the new path.
    await deps.onConflict(carried.to, {
      ...msg,
      path_hash: hashPathHex(deps.keys.mac_key, carried.to),
      deleted: false,
      version: 0,
    });
    return;
  }
  if (isCaseOnly(meta)) {
    await dropOldSpelling(meta.path, meta.renamed_to!, deps);
    closeName(meta.path, msg, deps);
    return;
  }
  // #697: nothing to carry: the note only leaves this name, so the file itself follows it
  // by a real vault rename and an editor open on it survives its name closing (#695).
  const to = meta.renamed_to;
  if (
    to !== undefined && deps.isSyncable?.(to) !== false && await followsNote(meta.path, to, deps)
  ) {
    closeName(meta.path, msg, deps);
    log.info("old name closed by a vault rename", { path: meta.path, to });
    return;
  }
  await applyDelete(msg, deps, meta);
}

/** #697: move the old file to the name the note opens, so an editor open on it survives
 * the old name closing (#695). False = close the old name as before. */
async function followsNote(from: string, to: string, deps: ApplyDeps): Promise<boolean> {
  // No handle in the index, no editor to keep: no reason to ask the server either.
  if (renameableFile(from, deps.vault) === null) return false;
  if (!await openedByNote(to, deps)) return false;
  return await followRename(from, to, deps);
}

/** #697: is the head at `to` open? A later version at the destination (the peer typed in
 * the new name, a coalesced replay winner) counts: only a closed head stops the move. An open
 * head need not be this marker's note (a rename that lost to an earlier marker commits a plain
 * create there); the move is then wasted, never lossy: the next applied version overwrites it. A note still in flight leaves no head at all, so the name is re-read
 * for a moment: the peer commits a rename's marker and its note back to back. When the
 * note's version lands before the marker (a retry after a rename conflict), the destination
 * file is already here, `destinationTaken` keeps it, and the old name closes as before. */
async function openedByNote(path: string, deps: ApplyDeps): Promise<boolean> {
  const headOf = deps.renameHeadOf;
  if (headOf === undefined) return false; // a rebuild has no transport to ask
  const pathHash = hashPathHex(deps.keys.mac_key, path);
  // Three reads, 100 ms apart: the peer's note follows its marker within a round trip.
  for (let attempt = 0; attempt < 3; attempt++) {
    let head: { deleted: number } | null;
    try {
      head = await headOf(pathHash);
    } catch {
      return false; // an unreadable head falls back to closing the old name
    }
    if (head) return head.deleted === 0;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** #613: `to` is where the note that left `from` now lives. A carried edit waiting on
 * `from` (a row with no version of its own) follows it: marked as a local edit so the
 * version landing at `to` merges it, or kept as a sibling when `to` is already taken.
 * The abandoned name is closed, never re-created. */
async function followCarriedEdit(from: string, to: string, deps: ApplyDeps): Promise<void> {
  const row = deps.state.getLocalFile(from);
  if (from === to || !row || row.deleted || row.last_seen_version !== 0) return;
  const carried = await carryLocalEdit({ path: from, renamedTo: to, pendingEdit: true }, deps);
  if (carried.kind === "none") return;
  deps.state.closeLocalRow(from, row.path_hash, row.last_seen_version);
  deps.markLocalEdit(carried.kind === "kept" ? carried.conflictPath : carried.to);
  log.info("carried edit follows the note to its new name", { from, to, carried: carried.kind });
}

/** A queued or promoted edit, or an untracked one: bytes on disk that differ from
 * the last synced version (an edit inside the debounce window or made while the app
 * was closed), or a file with no live row at all: #589. */
async function hasPendingEdit(
  path: string,
  row: LocalFileRow | null,
  deps: ApplyDeps,
): Promise<boolean> {
  if (deps.hasLocalEdits(path)) return true;
  if (!trustsDivergentDisk(path, deps)) return false;
  const diskHash = await diskPlaintextHash(path, deps.vault);
  if (diskHash === null) return false;
  if (!row || row.deleted) return true;
  return diskHash !== row.plaintext_hash;
}

/** Only the case differs between the old and new spelling. */
function isCaseOnly(meta: FileMeta): boolean {
  const to = meta.renamed_to;
  return to !== undefined && to !== meta.path && to.toLowerCase() === meta.path.toLowerCase();
}

/** The server's head row for a path: every rename-link check looks at it. */
export async function renameHeadOf(
  transport: { getVersionChain: (pathHash: string) => Promise<VersionRecord[]> },
  pathHash: string,
): Promise<VersionRecord | null> {
  return (await transport.getVersionChain(pathHash))[0] ?? null;
}

/** #583: a content version this device never applied, overtaken by its own plain delete
 * (a rename the reconciler re-derived as delete + create): a marker would have carried
 * it over, a plain delete did not, so keep the peer's content as a sibling. */
async function keepOvertakenContent(
  msg: ServerVersion,
  row: LocalFileRow,
  deps: ApplyDeps,
): Promise<void> {
  if (msg.deleted || !row.deleted || row.last_seen_version <= msg.version) return;
  if (await carriedByMarker(msg, deps)) return;
  await keepVersionSibling(msg, deps, row.path);
}

/** #583: did a rename marker at/after `msg` carry this content version over? Only then
 * may a skipped or deferred version be dropped (a plain delete never carried it). */
export async function carriedByMarker(
  msg: ServerVersion,
  deps: { renameHeadOf?: ApplyDeps["renameHeadOf"] },
): Promise<boolean> {
  const head = await deps.renameHeadOf?.(msg.path_hash);
  return head?.rename_mark === RENAME_MARKER && head.version >= msg.version;
}

/** Keep a parked version's content next to where its file went (a conflict sibling):
 * both edits survive even when the rename itself never landed. */
export async function keepVersionSibling(
  msg: ServerVersion,
  deps: ApplyDeps,
  basePath: string,
): Promise<void> {
  const meta = await decryptMetadata(b64decode(msg.enc_metadata), deps.keys, msg.path_hash);
  const bytes = await reassemble(msg.chunk_hashes, deps.keys, deps.getBlob, meta.plaintext_hash);
  const conflictPath = await freeConflictPath(basePath, deps);
  await writeVaultBinary(conflictPath, bytes, Date.now(), deps.vault);
  log.info("deferred version kept next to the renamed file", {
    path: meta.path,
    base: basePath,
    conflictPath,
  });
}

/** A version that collides with local bytes: hand it to the conflict handler. The
 * cursor still advances: the version is accounted for, the local copy is kept. */
async function conflictNow(path: string, msg: ServerVersion, deps: ApplyDeps): Promise<void> {
  log.info("apply conflict", { path, version: msg.version });
  // Marked first: the bytes on disk are a local edit, and a state rebuild (resync)
  // must keep them: its conflict hook is a stub, but its mark survives prune (#583).
  deps.markLocalEdit(path);
  await deps.onConflict(path, msg);
  deps.state.advanceSyncCursor(msg.seq);
}

async function applyDelete(msg: ServerVersion, deps: ApplyDeps, meta: FileMeta): Promise<void> {
  deps.suppressSelfWrite(meta.path);
  try {
    await removeVaultPath(meta.path, deps.vault);
  } catch (error) {
    // NotFound (file already gone) is benign; a real failure must not mark
    // deleted. Check presence directly (both Real Obsidian and FakeVault expose
    // getAbstractFileByPath): if the file survived the removal, rethrow without
    // marking deleted (the reconciler retries, not resurrects).
    const present = deps.vault.getAbstractFileByPath?.(meta.path) ?? null;
    if (present !== null) {
      log.error("apply delete failed", {
        path: meta.path,
        version: msg.version,
        error: String(error),
      });
      throw error;
    }
  }

  log.info("apply deleted", { path: meta.path, version: msg.version });
  closeName(meta.path, msg, deps);
}

/** Close a name whose file is already gone: a rename moved it, or it never was here. */
function closeName(path: string, msg: ServerVersion, deps: ApplyDeps): void {
  deps.state.closeLocalRow(path, msg.path_hash, msg.version);
  deps.state.advanceSyncCursor(msg.seq);
  deps.recordActivity?.({ path, kind: "delete", deviceId: msg.device_id });
  // A conflict file resolved on another device arrives as a remote delete;
  // clear the local conflict count for it too.
  deps.onConflictFileDeleted?.(path);
}

/** #342: a name this device does not sync: skip the apply but advance the cursor so the
 * stream is not blocked. Nothing is deleted locally or on the server; catch-up fetches
 * the server heads for these paths when the folder is switched back on. #584: the same
 * for the parked name of a file moved into an excluded folder: it is not this device's
 * to write (no resurrected old name next to the parked file), and the marker that
 * resolves the parked move carries a peer's edit there over instead. Only while that
 * name is still the closed row the park left: a new file re-using it is a live name and
 * its versions must apply. */
function skipsApply(path: string, msg: ServerVersion, deps: ApplyDeps): boolean {
  const outOfScope = deps.isSyncable !== undefined && !deps.isSyncable(path);
  const parked = !outOfScope && deps.isParkedMove?.(path) === true &&
    deps.state.getLocalFile(path)?.deleted === true;
  if (!outOfScope && !parked) return false;
  log.debug("apply skipped (out of scope)", {
    path,
    version: msg.version,
    parked: !outOfScope,
  });
  deps.state.advanceSyncCursor(msg.seq);
  return true;
}

/** Content for a path this device is editing, deleting, or renaming away.
 * True = already accounted for here. */
async function applyContentOrConflict(
  msg: ServerVersion,
  deps: ApplyDeps,
  meta: FileMeta,
): Promise<boolean> {
  // #583: this device is renaming the file away (the delete has not been pushed yet):
  // a peer's version for the old name belongs at the destination, never back here. The
  // marker that follows this content version carries it over (commit.ts).
  const renameTo = deps.pendingRenameTarget(meta.path);
  if (renameTo) {
    // The rename's marker carries this version over when it lands; until then it stays
    // parked and the cursor stays behind it, so losing the rename op (a throw, a lock,
    // a restart) can never drop the peer's edit.
    log.info("apply deferred to a pending rename", { path: meta.path, version: msg.version });
    deps.parkDeferred?.(msg, renameTo);
    // The version is still owed: keep the cursor behind it so a reconnect (or a
    // restart after the rename ops are lost) delivers it again.
    deps.state.holdSyncCursor(msg.seq);
    return true;
  }
  // #593: a plain delete of this path is queued (or still inside the event debounce)
  // and the bytes are already gone, so nothing below can see the delete: delete-vs-edit
  // (#361), handled by `applyOverPendingDelete`.
  if (
    deps.hasPendingDelete?.(meta.path) &&
    await diskPlaintextHashIfPresent(meta.path, deps.vault) === null
  ) {
    await applyOverPendingDelete(msg, deps, meta, deps.state.getLocalFile(meta.path));
    return true;
  }
  if (!deps.hasLocalEdits(meta.path)) return false;
  await conflictNow(meta.path, msg, deps);
  return true;
}

/** Disk bytes that match neither the row nor the incoming version: an untracked local
 * edit. Promote it to a TRACKED one so the normal hasLocalEdits->onConflict merge path
 * owns it on this and every subsequent (possibly replayed) version: marked first, so a
 * state rebuild keeps the bytes (its conflict hook is a stub); the handler clears the
 * mark once it has surfaced them. True = already accounted for here.
 * #701: a rejoin answers false for the bytes it set aside: the server version wins. */
async function keepsDivergentBytes(
  msg: ServerVersion,
  deps: ApplyDeps,
  meta: FileMeta,
  localRow: LocalFileRow | null,
  tracked: string | null,
  dh: string | null,
): Promise<boolean> {
  if (dh === null || dh === tracked || dh === meta.plaintext_hash) return false;
  if (!trustsDivergentDisk(meta.path, deps)) return false;
  deps.markLocalEdit(meta.path);
  // For binary files there is no 3-way merge, so the deferred commit would
  // silently overwrite one side. Surface a conflict immediately instead.
  const mergeable = meta.mime === "text/markdown" || meta.mime === "text/plain";
  if (!mergeable) {
    await conflictNow(meta.path, msg, deps);
    return true;
  }
  // Keep the edit's TRUE parent (localRow.last_seen_version) so the eventual commit
  // sends a stale parent_version → server returns conflict → 3-way merge runs →
  // both edits survive. Advance the sync cursor so the server doesn't replay this
  // version, but leave disk untouched. A closed row must stop claiming its delete,
  // or the merge would take the server's side over the edit, and it must stop
  // claiming its hash too: a re-created file can hold exactly the bytes the closed
  // row kept, and the reconciler reads matching bytes as already uploaded and never
  // commits, leaving the version parked forever (#583).
  if (localRow?.deleted) {
    deps.state.upsertLocalFile({ ...localRow, deleted: false, plaintext_hash: "" });
  }
  deps.state.advanceSyncCursor(msg.seq);
  return true;
}

async function applyContent(msg: ServerVersion, deps: ApplyDeps, meta: FileMeta): Promise<void> {
  const localRow = deps.state.getLocalFile(meta.path);
  const tracked = localRow && !localRow.deleted ? localRow.plaintext_hash : null;
  const dh = await diskPlaintextHashIfPresent(meta.path, deps.vault);
  // A rebuild re-applies every head: when the disk already holds exactly these bytes,
  // record the version and skip the reassemble+write (a resync must not re-download
  // and rewrite a whole vault to restore the files that are actually missing).
  if (tracked !== null && dh === tracked && dh === meta.plaintext_hash) {
    deps.state.upsertLocalFile({
      path: meta.path,
      path_hash: msg.path_hash,
      size: meta.size,
      mtime: meta.mtime,
      plaintext_hash: meta.plaintext_hash,
      last_seen_version: msg.version,
      chunk_hashes: msg.chunk_hashes,
      deleted: false,
    });
    deps.state.advanceSyncCursor(msg.seq);
    log.debug("apply skipped (disk already holds this version)", {
      path: meta.path,
      version: msg.version,
    });
    return;
  }
  // Disk holds an untracked local edit when it matches neither the tracked row nor
  // the incoming version: an edit still inside the event debounce (#589), one made
  // while offline / before a restart, or a create the reconciler has not queued yet,
  // a rename onto this name, or a second device's create, landing first (#590, #181).
  if (await keepsDivergentBytes(msg, deps, meta, localRow, tracked, dh)) return;

  log.debug("apply reassemble", {
    path: meta.path,
    version: msg.version,
    chunks: msg.chunk_hashes.length,
  });
  const bytes = await reassemble(
    msg.chunk_hashes,
    deps.keys,
    deps.getBlob,
    meta.plaintext_hash,
  );

  if (deps.recheckDiskBeforeWrite) {
    const atWrite = await diskPlaintextHashIfPresent(meta.path, deps.vault);
    if (await keepsDivergentBytes(msg, deps, meta, localRow, tracked, atWrite)) return;
  }

  deps.suppressSelfWrite(meta.path);
  await writeVaultBinary(meta.path, bytes, meta.mtime, deps.vault);

  deps.state.upsertLocalFile({
    path: meta.path,
    path_hash: msg.path_hash,
    size: meta.size,
    mtime: meta.mtime,
    plaintext_hash: meta.plaintext_hash,
    last_seen_version: msg.version,
    chunk_hashes: msg.chunk_hashes,
    deleted: false,
  });
  deps.state.advanceSyncCursor(msg.seq);
  log.info("applied", { path: meta.path, version: msg.version });
  // #687: this device's own restore: the file came back from the trash here, so the
  // Activity view says "Restored", not "Downloaded · <own name>". Only a marked version
  // gets here as an own version: an unmarked one returns above, and a forced catch-up
  // applies a head, which carries no device_id.
  const own = msg.device_id === deps.myDeviceId;
  deps.recordActivity?.({
    path: meta.path,
    kind: own ? "restore" : "download",
    deviceId: msg.device_id,
  });
}
