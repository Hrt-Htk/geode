// #59: what a killed session left behind, resolved. A phone force-stop inside a write
// leaves a torn file whose row never persisted (rows write on a throttle), and the
// reconciler would read that fragment as a local create while the merger keeps it as a
// conflict copy. Every write of bytes the user did not type is recorded before it starts
// (see `recordedWrite`), so one pass at the next start can tell what happened:

import { b64decode, headToServerVersion, type VersionRecord } from "../../core/protocol.ts";
import { decryptChunk, decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { blake3Hex } from "../../core/hash.ts";
import { normalizeForHash } from "../../core/normalize.ts";
import { type InFlightWrite, StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import { type ApplyDeps, applyVersion } from "./apply.ts";
import { readVaultBinary, removeVaultPath } from "./vault-io.ts";

export interface InterruptedWriteDeps {
  state: StateDB;
  keys: VaultKeys;
  vaultId: string;
  /** The pipeline's apply deps, with `force` and the record making this device's own write. */
  apply: ApplyDeps;
  /** The newest server row for a path, or null when the server never committed it. */
  chainHead: (pathHash: string) => Promise<VersionRecord | null>;
}

/** Resolve every recorded write from a killed session. A resolved entry (any of the
 * outcomes below) is cleared; one whose resolution failed, because the server could not
 * answer or a vault write errored, stays recorded and gated, and the next connection tries
 * again. That is not a frozen path: it only waits while nothing can sync anyway. */
export async function resolveInterruptedWrites(
  deps: InterruptedWriteDeps,
): Promise<InFlightWrite[]> {
  const entries = deps.state.getInterruptedWrites();
  if (entries.length === 0) return [];
  // This pass owns the verdict for a recorded path, and its applies write over the fragment.
  const apply: ApplyDeps = { ...deps.apply, force: true, managesInterrupted: true };
  const resolved: InFlightWrite[] = [];
  let torn = 0;
  for (const entry of entries) {
    // Another (abandoned) pass may still be writing this path: starting a second write on it
    // would overlap, and its bytes are that pass's to judge. Skip it; it stays gated.
    if (!deps.state.claimInterrupted(entry.path_hash)) continue;
    try {
      if (await resolveOne(entry, { ...deps, apply })) torn++;
      resolved.push(entry);
    } catch (error) {
      log.warn("interrupted write not resolved, retrying at the next connection", {
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      deps.state.releaseResolve(entry.path_hash);
    }
  }
  await deps.state.clearInterruptedWrites(resolved);
  log.info("resolved interrupted writes", {
    entries: entries.length,
    resolved: resolved.length,
    torn,
  });
  return resolved;
}

/** One entry. True = the bytes on disk were a fragment of this device's own write.
 *
 * The local verdicts come first and cost no network: nothing on disk, the row's bytes, or
 * exactly what the write meant to leave. */
async function resolveOne(entry: InFlightWrite, deps: InterruptedWriteDeps): Promise<boolean> {
  const disk = await readVaultBinary(entry.path, deps.apply.vault);
  if (disk === null) {
    // Only a POSITIVELY absent file means the write never reached the disk. An unreadable one
    // (a mobile FS bridge error) is not absence: the record stays, and the next connection
    // tries again, or its bytes would be committed as a fragment.
    if (await isAbsent(entry.path, deps)) return false;
    throw new Error("the recorded file could not be read");
  }
  const diskHash = diskIdentity(entry.path, disk);
  if (diskHash === deps.state.getLocalFile(entry.path)?.plaintext_hash) return false;
  if (diskHash === entry.expected_plaintext_hash) return false; // the write completed
  const head = await deps.chainHead(entry.path_hash);
  if (head === null) {
    // No head: the server never committed this path. Heads are never compacted away, so
    // these are copies this device makes for itself (a conflict sibling, a rejoin backup),
    // and the write was shorter than what it meant to leave: a torn copy, removed. Longer
    // bytes are somebody else's (an editor outside Obsidian): kept, never deleted.
    if (disk.length < entry.expected_size) {
      await removeVaultPath(entry.path, deps.apply.vault);
      return true;
    }
    return false;
  }
  const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, head.path_hash);
  if (diskHash === meta.plaintext_hash) return false; // landed at the head
  // A deleted or renamed head has no content to compare, and these bytes are not ours to
  // overwrite: the normal apply owns that path.
  if (head.deleted) return false;
  // Only a PREFIX of what the head holds is a torn write of ours; anything else was written
  // by something outside Obsidian after the kill. Fetch just the chunks the disk file
  // covers: a torn file is short, so the pass never downloads a whole head for this.
  if (disk.length >= meta.size || disk.length >= entry.expected_size) return false;
  const prefix = await headPrefix(head.chunk_hashes, deps, disk.length);
  if (!isPrefix(disk, prefix)) return false;
  // Torn: the head goes over it. `isTorn` is still true for this path (the record is cleared
  // after the pass), so the apply cannot read the fragment as a local edit.
  await applyVersion(headToServerVersion(head, deps.vaultId), deps.apply);
  return true;
}

/** The head's first `limit` bytes, chunk by chunk. */
async function headPrefix(
  chunkHashes: string[],
  deps: InterruptedWriteDeps,
  limit: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let fetched = 0;
  for (const hash of chunkHashes) {
    if (fetched >= limit) break;
    const part = await decryptChunk(await deps.apply.getBlob(hash), deps.keys, hash);
    parts.push(part);
    fetched += part.length;
  }
  const prefix = new Uint8Array(Math.min(fetched, limit));
  let offset = 0;
  for (const part of parts) {
    const take = Math.min(part.length, prefix.length - offset);
    prefix.set(part.subarray(0, take), offset);
    offset += take;
    if (offset >= prefix.length) break;
  }
  return prefix;
}

/** Positively absent: the adapter says the path is not there (a throwing or missing check is
 * no evidence of absence). */
async function isAbsent(path: string, deps: InterruptedWriteDeps): Promise<boolean> {
  const exists = deps.apply.vault.adapter.exists;
  if (typeof exists !== "function") return false;
  return await exists.call(deps.apply.vault.adapter, path).catch(() => false) === false;
}

const diskIdentity = (path: string, bytes: Uint8Array): string =>
  blake3Hex(normalizeForHash(path, bytes));

/** A torn write leaves the first bytes of what it meant to write, never more. */
function isPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}
