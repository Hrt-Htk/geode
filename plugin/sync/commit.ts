import { detectMime, isMarkdownPath, normalizeForHash } from "../../core/normalize.ts";
import { blake3Hex, hashPathHex } from "../../core/hash.ts";
import { chunk } from "../../core/chunker.ts";
import {
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  encryptPath,
  VaultKeys,
} from "../../core/crypto.ts";
import {
  b64decode,
  b64encode,
  type FileMeta,
  RENAME_MARKER,
  type VersionRecord,
} from "../../core/protocol.ts";
import { log } from "../plumbing/log.ts";
import { type LocalFileRow, StateDB } from "../plumbing/state.ts";
import { Transport } from "./transport.ts";
import { acquirePathLock } from "./path-lock.ts";
import type { CommitResult } from "./commit-channel.ts";
import { renameHeadOf } from "./apply.ts";
import { carryLocalEdit } from "./rename-carry.ts";
import { isLateSave } from "./late-save.ts";
import {
  type CollapsedChain,
  collapseRenameChain,
  forgetChain,
  isUnwritten,
} from "./rename-chain.ts";
import { noteFor, resolveNoteConflict } from "./rename-note.ts";
import { readVaultBinary, type Vault as ApplyVault, writeVaultBinary } from "./vault-io.ts";
import { mergeText, readVersionBytes, surfaceConflict } from "./merger.ts";
import { toUint8Array } from "../plumbing/bytes.ts";
import type { ActivityRecord } from "./activity-log.ts";

/** commit also reads the body and stats the file (mtime, the #498 stale guard). */
export type Vault = Omit<ApplyVault, "adapter"> & {
  adapter: ApplyVault["adapter"] & {
    readBinary: (path: string) => Promise<Uint8Array>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<{ size: number; mtime: number } | null>;
  };
};

/** #583: the two halves of a rename link an op can carry (one type, three ops). */
export interface RenameLink {
  /** the rename that produced the link: two renames never share one, even in the
   * same millisecond (an op with no id of its own: the reconciler, a later event,
   * inherits the pending link) */
  renameId?: string;
  /** a delete's destination (marker) */
  renamedTo?: string;
  /** a create's source (note) */
  renamedFrom?: string;
}

/** #583: one id per rename, so a superseding op can tell a rename's own ops from a
 * different rename (or a plain edit) landing on the same path. */
let renameSeq = 0;

/** The next rename id: shared by the event layer and the reconciler so two renames
 * never look like one, even in the same millisecond. */
export function nextRenameId(): string {
  return `r${++renameSeq}`;
}

export interface CommitOp extends RenameLink {
  path: string;
  kind: "commit" | "delete";
}

export interface CommitDeps {
  vault: Vault;
  state: StateDB;
  keys: VaultKeys;
  transport: Transport;
  onConflict: (
    path: string,
    serverHead: { path_hash: string; version: number },
  ) => Promise<void> | void;
  /** #431: per-file activity. Own commits record an upload; the merge-commit
   *  call site omits this so orchestrateMerge records the merge instead. */
  recordActivity?: ActivityRecord;
  /** #583: decisions 2/9 need this device's identity and a way to stop the disk
   * writes a carried rename edit makes from enqueueing a second rename. */
  deviceId?: string;
  deviceName?: string;
  suppressSelfWrite?: (path: string) => void;
  /** #697: pair marks of this device's own applied renames. */
  suppressSelfRename?: (from: string, to: string) => () => void;
  /** #583: destinations whose rename lost to another device's marker. Owned by the
   * commit queue, so it is vault-scoped and dies with the session. */
  abandonedRenames?: Set<string>;
  /** #595: a rename-away of this path this device is closing (queued, or still in the
   * event debounce): a carried edit must never reopen it. */
  pendingRenameTarget: (path: string) => string | undefined;
  /** #615: the middle names a collapsed rename chain skipped over, each with the name
   * the chain started from and its final destination. Owned by the commit queue. */
  collapsedChains?: Map<string, CollapsedChain>;
}

/** One commit per path at a time, per vault: the module is shared by every plugin
 * instance in a process (and by every device the fuzz driver runs), so a path alone
 * would let one vault's hung commit swallow another vault's op. */
const inFlight = new WeakMap<StateDB, Map<string, Promise<boolean>>>();

function inFlightOf(state: StateDB): Map<string, Promise<boolean>> {
  let runs = inFlight.get(state);
  if (!runs) inFlight.set(state, runs = new Map());
  return runs;
}

/** Never call this from inside a conflict resolution: the resolution holds this path's
 * lock, so the op would wait on itself until the lock times out (#630). */
export async function commitOp(op: CommitOp, deps: CommitDeps): Promise<boolean> {
  const runs = inFlightOf(deps.state);
  if (runs.has(op.path)) return true;
  // #630: a server conflict is settled by a resolution, which takes this path's lock
  // and re-reads the disk. Hand it over only once this op has released the lock, or it
  // waits on the very commit that raised the conflict.
  const conflicts: Array<{ path: string; head: { path_hash: string; version: number } }> = [];
  const depsDeferred = {
    ...deps,
    onConflict: (path: string, head: { path_hash: string; version: number }) => {
      conflicts.push({ path, head });
    },
  };
  const run = (async () => {
    const lock = await acquirePathLock(deps.state, op.path);
    if (!lock) {
      log.warn("commit deferred: a resolution has held this path too long", { path: op.path });
      return false; // the queue retries it; a silent true would drop the edit
    }
    try {
      return op.kind === "delete"
        ? await commitDelete(op.path, depsDeferred, op.renamedTo)
        : await commitFile(op.path, depsDeferred, op.renamedFrom);
    } finally {
      lock();
    }
  })();
  runs.set(op.path, run);
  let result: boolean;
  try {
    result = await run;
  } finally {
    if (runs.get(op.path) === run) runs.delete(op.path);
  }
  for (const conflict of conflicts) await deps.onConflict(conflict.path, conflict.head);
  return result;
}

/** Wait for a same-path commit already in flight, so a resolution's commit is
 * not silently dropped by commitOp's dedup. Bounded: a commit that hangs (an
 * unsent commit over a dropped socket has no timeout) must never block the
 * caller: commitOp's dedup then falls back to the pre-#432 skip. */
/** Resolves true once no commit for `path` is in flight, false on timeout. */
export async function waitForInFlightCommit(
  state: StateDB,
  path: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const runs = inFlight.get(state);
  const prior = runs?.get(path);
  if (!prior) return true;
  await Promise.race([prior.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
  return !runs?.has(path);
}

/** The file vanished under a live row: the edit is nowhere, so retrying cannot help,
 * the op is dropped and counted, never silently forgotten (#589). */
export class CommitFileVanished extends Error {}

async function commitFile(path: string, deps: CommitDeps, renamedFrom?: string): Promise<boolean> {
  if (await followClosedRename(path, deps, renamedFrom)) return true;
  // Stat BEFORE the read: the mtime must belong to bytes read at or after it. Writers
  // outside the path lock (an apply's version write, an execution of a conflict
  // resolution, a history restore) can land in between: they then leave the row's
  // mtime older than the file's, which the reconciler re-reads as drift. Statting after
  // the read let such a write's mtime sit on the older row hash instead: row and disk
  // disagreeing under one mtime, invisible to that fast path (#630).
  const stat = await deps.vault.adapter.stat(path);
  let body: Uint8Array;
  try {
    body = toUint8Array(await deps.vault.adapter.readBinary(path));
  } catch (error) {
    // The path vanished before its commit ran. A closed row accounts for that: a
    // marker carried the edit to its new name, or the file was deleted, but with
    // the row still live the edit is nowhere: never lose it behind a log line, let
    // it surface so the queue counts the op as dropped.
    if (deps.state.getLocalFile(path)?.deleted) return true;
    throw new CommitFileVanished(`${path}: ${String(error)}`, { cause: error });
  }
  return commitFileBytes(path, body, stat?.mtime ?? Date.now(), deps, { renamedFrom });
}

export async function commitFileBytes(
  path: string,
  body: Uint8Array,
  mtime: number,
  deps: CommitDeps,
  opts: { force?: boolean; renamedFrom?: string } = {},
): Promise<boolean> {
  const { force, renamedFrom } = opts;
  const normalized = normalizeForHash(path, body);
  const plaintextHash = blake3Hex(normalized);
  const local = deps.state.getLocalFile(path);
  if (unchangedSinceLastCommit(force, local, plaintextHash)) {
    log.debug("commit skipped (content unchanged)", { path, plaintext_hash: plaintextHash });
    return true;
  }

  const chunkHashes = await uploadChunks(normalized, deps);

  // #583: the note is written once, by the first version of a path that has no
  // server history: a re-run, or a copy onto a reused name, starts its own.
  const note = await noteFor(path, renamedFrom, local, deps);
  const meta = {
    path,
    mtime,
    size: normalized.length,
    mime: detectMime(path),
    plaintext_hash: plaintextHash,
    ...note?.fields,
  };
  const pathHash = hashPathHex(deps.keys.mac_key, path);
  const encMeta = await encryptMetadata(meta, deps.keys, pathHash);
  const encMetaB64 = b64encode(encMeta);

  const pathCiphertext = b64encode(await encryptPath(path, deps.keys, pathHash));
  const send = (parentVersion: number | null) =>
    deps.transport.commit({
      path_hash: pathHash,
      parent_version: parentVersion,
      enc_metadata: encMetaB64,
      chunk_hashes: chunkHashes,
      deleted: false,
      path_ciphertext: pathCiphertext,
      rename_mark: note?.mark,
    });

  const result = await resolveNoteConflict(
    await send(local?.last_seen_version ?? null),
    note?.mark,
    {
      pathHash,
      note: note?.mark !== undefined,
      deps,
      send,
    },
  );

  if (result.kind === "ack") {
    deps.state.upsertLocalFile({
      path,
      path_hash: pathHash,
      size: meta.size,
      mtime: meta.mtime,
      plaintext_hash: plaintextHash,
      last_seen_version: result.version,
      chunk_hashes: chunkHashes,
    });
    forgetChain(deps.collapsedChains, path);
    log.info("committed", { path });
    deps.recordActivity?.({ path, kind: "upload" });
    return true;
  } else if (result.kind === "conflict") {
    await deps.onConflict(path, {
      path_hash: result.path_hash,
      version: result.parent_version,
    });
    forgetChain(deps.collapsedChains, path);
    return true;
  } else {
    log.warn("commit error", { path, message: result.message });
    deps.recordActivity?.({ path, kind: "error", cause: result.message });
    return false;
  }
}

/** #583: this file was written under a name a rename already closed (this device had
 * not applied the marker yet when its user saved): follow the note instead of
 * reopening the old name. Both edits are kept (the destination holds one, a sibling
 * conflict file the other). True = handled, nothing to commit at the old name. #695,
 * only a late save follows: a new note that reused the free name stays where it is. */
async function followClosedRename(
  path: string,
  deps: CommitDeps,
  renamedFrom?: string,
): Promise<boolean> {
  // Our own rename opens this name: the peer's marker on it belongs to the previous
  // generation, so the note commit must proceed (it re-sends over the closed head).
  if (renamedFrom) return false;
  const row = deps.state.getLocalFile(path);
  if (!row?.deleted || row.last_seen_version === 0) return false;
  const head = (await deps.transport.getVersionChain(row.path_hash))[0];
  if (head?.rename_mark !== RENAME_MARKER) return false;
  // Our own rename closed the name: writing it again is the user re-creating the file
  // (a new generation), not a resurrection of someone else's.
  if (head.device_id === deps.deviceId) return false;
  const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, row.path_hash);
  const to = meta.renamed_to;
  if (!to) return false;
  // #695: a late save is text: anything else that turns up at the name (an image, a
  // PDF) is a new file, and its bytes are not worth a diff inside the path lock.
  if (!isMarkdownPath(path)) return false;
  const body = await readVaultBinary(path, deps.vault);
  if (body === null) return false;
  const destination = await readVaultBinary(to, deps.vault);
  if (!isLateSave(body, destination)) {
    // #695: a new note reusing the free name (Obsidian names every new note
    // "Untitled"): it opens its own generation here, it does not follow the note.
    log.info("new note kept at a name a peer renamed away", { path, to });
    return false;
  }
  const carried = await carryLocalEdit(
    { path, renamedTo: to, pendingEdit: true },
    {
      vault: deps.vault,
      state: deps.state,
      keys: deps.keys,
      suppressSelfWrite: deps.suppressSelfWrite ?? (() => {}),
      suppressSelfRename: deps.suppressSelfRename,
      deviceName: deps.deviceName,
      renameHeadOf: (pathHash) => renameHeadOf(deps.transport, pathHash),
      pendingRenameTarget: deps.pendingRenameTarget,
    },
  );
  if (carried.kind === "none") return false;
  if (carried.kind === "moved") {
    // Let the normal merge path fold the edit into the destination row.
    await deps.onConflict(carried.to, {
      path_hash: hashPathHex(deps.keys.mac_key, carried.to),
      version: 0,
    });
  }
  log.info("followed the rename instead of reopening the old name", {
    path,
    to,
    carried: carried.kind,
  });
  return true;
}

/** Upload every chunk the server is missing; returns the plaintext hashes. */
async function uploadChunks(normalized: Uint8Array, deps: CommitDeps): Promise<string[]> {
  const chunkHashes: string[] = [];
  for (const c of chunk(normalized)) {
    const h = blake3Hex(c);
    chunkHashes.push(h);
    if (await deps.transport.headBlob(h)) continue;
    const enc = await encryptChunk(c, deps.keys, h);
    await deps.transport.putBlob(h, enc);
  }
  return chunkHashes;
}

/** #583/#615: nothing to close: the name is already closed, a rename chain this device
 * collapsed never opened it, or the file a plain delete meant to remove is still there
 * (#498: the index drops a real delete at once, the disk check covers an index that
 * lags a file removed behind its back, mobile). A rename's marker is never eaten: after
 * a case-only rename on a case-insensitive FS the old name still resolves. */
async function deleteIsMoot(
  path: string,
  local: LocalFileRow,
  to: string | undefined,
  deps: CommitDeps,
): Promise<boolean> {
  // #615: the middle of a collapsed chain: the name holds nothing of this file, so a
  // marker would join the generation that held the name before (and clear its trash
  // entry). The same "unwritten" test the collapse used decides it.
  if (to !== undefined) {
    return deps.collapsedChains?.has(path) === true && isUnwritten(path, deps.state);
  }
  // A rename still records its link when the name was already closed by someone else
  // (a concurrent delete or rename): the marker either promotes over a plain tombstone
  // (§6) or gives up the history to the earlier marker (decision 9).
  if (local.deleted) return true;
  return deps.vault.getAbstractFileByPath?.(path) != null &&
    await existsOnDisk(path, deps.vault.adapter);
}

async function commitDelete(path: string, deps: CommitDeps, renamedTo?: string): Promise<boolean> {
  const local = deps.state.getLocalFile(path);
  if (!local) return true;
  // #629: a cancelled chain (its own name was deleted before it opened) is no rename:
  // the queue already resolved it to a plain tombstone, so this is never null here.
  const to = renamedTo === undefined
    ? undefined
    : collapseRenameChain(path, renamedTo, deps) ?? undefined;
  // #615: renamed away and back inside one debounce: the file never left, so this name
  // is not closed (the queued commit at it is just its next version).
  if (to === path) return true;
  if (await deleteIsMoot(path, local, to, deps)) return true;

  const send = await deleteSender(path, local.path_hash, to, deps);
  let result = await send(local.last_seen_version);
  if (to && result.kind === "conflict") {
    const resolution = await resolveRenameConflict(
      result.parent_version,
      { path, pathHash: local.path_hash, renamedTo: to, lastSeen: local.last_seen_version },
      deps,
      send,
    );
    if (resolution.kind === "settled" || resolution.kind === "abandoned") {
      forgetChain(deps.collapsedChains, path);
      return true;
    }
    // Retryable: the old name stays open until the head edit can be carried.
    if (resolution.kind === "failed") return false;
    if (resolution.kind === "retry") result = resolution.result;
  }

  const settled = await settleDelete(path, local, result, deps);
  if (settled) forgetChain(deps.collapsedChains, path);
  return settled;
}

/** The tombstone/marker request and its re-send: a marker promoted over a tombstone
 * goes out again at the new parent with the same encrypted metadata. */
async function deleteSender(
  path: string,
  pathHash: string,
  renamedTo: string | undefined,
  deps: CommitDeps,
): Promise<(parentVersion: number) => Promise<CommitResult>> {
  const meta: FileMeta = { path, mtime: Date.now(), size: 0, mime: "", plaintext_hash: "" };
  if (renamedTo) meta.renamed_to = renamedTo;
  const encMetaB64 = b64encode(await encryptMetadata(meta, deps.keys, pathHash));
  const pathCiphertext = b64encode(await encryptPath(path, deps.keys, pathHash));
  return (parentVersion: number) =>
    deps.transport.commit({
      path_hash: pathHash,
      parent_version: parentVersion,
      enc_metadata: encMetaB64,
      chunk_hashes: [],
      deleted: true,
      path_ciphertext: pathCiphertext,
      rename_mark: renamedTo ? RENAME_MARKER : undefined,
    });
}

async function settleDelete(
  path: string,
  local: LocalFileRow,
  result: CommitResult,
  deps: CommitDeps,
): Promise<boolean> {
  if (result.kind === "ack") {
    deps.state.upsertLocalFile({ ...local, last_seen_version: result.version, deleted: true });
    deps.recordActivity?.({ path, kind: "delete", deviceId: null });
    return true;
  }
  if (result.kind === "conflict") {
    await deps.onConflict(path, {
      path_hash: result.path_hash,
      version: result.parent_version,
    });
    return true;
  }
  log.warn("commit delete error", { path, message: result.message });
  deps.recordActivity?.({ path, kind: "error", cause: result.message });
  return false;
}

/** Skip unchanged content before any chunk/upload work: never a deleted local file
 * (it must be re-committed), never a force (merge) commit, and: #583: never a row
 * with `last_seen_version === 0` (a carried row, or a destination a race had to keep
 * both for: nothing of this path is on the server yet). */
function unchangedSinceLastCommit(
  force: boolean | undefined,
  local: LocalFileRow | null,
  plaintextHash: string,
): boolean {
  if (force || !local || local.deleted || local.last_seen_version === 0) return false;
  return local.plaintext_hash === plaintextHash;
}

type MarkerResolution =
  /** the old name was closed by our own marker already */
  | { kind: "settled" }
  /** another device's marker owns this history (decision 9) */
  | { kind: "abandoned" }
  /** re-send the marker over the new head */
  | { kind: "retry"; result: CommitResult }
  /** the head edit could not be carried: retry the op, keep the old name open */
  | { kind: "failed" }
  /** no head to work with: let the conflict handler decide */
  | { kind: "conflict" };

/** §6/§9 and the editor-first race: the marker lost its old path. Over a plain
 * tombstone the rename wins (the server clears its trash row); over a content head
 * the edit is carried to the new name first; over another device's marker the
 * history is theirs, so this device's file stays a plain copy. */
async function resolveRenameConflict(
  conflictParent: number,
  marker: { path: string; pathHash: string; renamedTo: string; lastSeen: number },
  deps: CommitDeps,
  send: (parentVersion: number) => Promise<CommitResult>,
): Promise<MarkerResolution> {
  const head = (await deps.transport.getVersionChain(marker.pathHash, conflictParent))[0];
  if (!head) return { kind: "conflict" };
  if (head.rename_mark === RENAME_MARKER) {
    if (head.device_id !== deps.deviceId) {
      deps.state.closeLocalRow(marker.path, marker.pathHash, head.version);
      deps.abandonedRenames?.add(marker.renamedTo);
      log.info("rename lost to an earlier marker", { path: marker.path, version: head.version });
      return { kind: "abandoned" };
    }
    deps.state.closeLocalRow(marker.path, marker.pathHash, head.version);
    return { kind: "settled" };
  }
  if (!head.deleted && !await carryHeadEdit(head, marker, deps)) return { kind: "failed" };
  return { kind: "retry", result: await send(head.version) };
}

/** The old name advanced before our marker landed: 3-way merge that edit into the
 * rename's destination, with the version this device last saw as the base. Clean ⇒
 * the merged bytes land at the destination; otherwise both sides are kept (the
 * destination takes the server's copy, the local edit a sibling conflict file). */
async function carryHeadEdit(
  head: VersionRecord,
  marker: { path: string; pathHash: string; renamedTo: string; lastSeen: number },
  deps: CommitDeps,
): Promise<boolean> {
  const remote = await readVersionBytes(
    head,
    marker.pathHash,
    deps.keys,
    (h) => deps.transport.getBlob(h),
  ).catch(() => null);
  const local = await readVaultBinary(marker.renamedTo, deps.vault);
  if (remote === null || local === null) {
    // Never close the old name over an edit we could not read: the caller retries the
    // op instead, and after the retry budget the old name simply stays open.
    log.warn("cannot carry the old name's edit, keeping both", {
      path: marker.path,
      to: marker.renamedTo,
      version: head.version,
      remoteReadable: remote !== null,
      localReadable: local !== null,
    });
    return false;
  }
  const base = await mergeBase(marker.pathHash, marker.lastSeen, deps);
  if (base?.version === head.version) return true; // head = what we last saw: nothing to carry
  const mime = detectMime(marker.renamedTo);
  const text = base && (mime === "text/markdown" || mime === "text/plain")
    ? mergeText(local, base.bytes, remote)
    : null;
  deps.suppressSelfWrite?.(marker.renamedTo);
  if (text && "merged" in text) {
    await writeVaultBinary(marker.renamedTo, text.merged, Date.now(), deps.vault);
    log.info("carried an edit to the renamed file", { from: marker.path, to: marker.renamedTo });
    return true;
  }
  await surfaceConflict(
    {
      path: marker.renamedTo,
      pathHash: hashPathHex(deps.keys.mac_key, marker.renamedTo),
      serverContent: remote,
      localContent: local,
      serverVersion: 0,
      chunkHashes: [],
      reason: "rename_edit_race",
    },
    { vault: deps.vault, state: deps.state, deviceName: deps.deviceName ?? "" },
  );
  return true;
}

/** The content this device last saw of the old path (the merge base), or null when
 * it was compacted away. */
async function mergeBase(
  pathHash: string,
  lastSeen: number,
  deps: CommitDeps,
): Promise<{ version: number; bytes: Uint8Array } | null> {
  if (!lastSeen) return null;
  const chain = await deps.transport.getVersionChain(pathHash, lastSeen);
  const row = chain.find((r) => !r.deleted);
  if (!row) return null;
  const bytes = await readVersionBytes(row, pathHash, deps.keys, (h) => deps.transport.getBlob(h))
    .catch(() => null);
  return bytes === null ? null : { version: row.version, bytes };
}

/** Absent = null (real Obsidian) or a throw (#505). */
export async function existsOnDisk(
  path: string,
  adapter: { stat: (path: string) => Promise<unknown | null> },
): Promise<boolean> {
  try {
    return (await adapter.stat(path)) != null;
  } catch {
    return false;
  }
}
