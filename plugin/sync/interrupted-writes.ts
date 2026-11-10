// #59: what a killed session left behind, resolved. A phone force-stop inside a write
// leaves a torn file whose row never persisted (rows write on a throttle), and the
// reconciler would read that fragment as a local create while the merger keeps it as a
// conflict copy. Every write of bytes the user did not type is recorded before it starts
// (see `recordedWrite`), so one pass at the next start can tell what happened:

import { b64decode, headToServerVersion, type VersionRecord } from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { type InFlightWrite, StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import { type ApplyDeps, applyVersion } from "./apply.ts";
import { diskPlaintextHashIfPresent, removeVaultPath } from "./vault-io.ts";

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
export async function resolveInterruptedWrites(deps: InterruptedWriteDeps): Promise<void> {
  const entries = deps.state.getInterruptedWrites();
  if (entries.length === 0) return;
  const resolved: string[] = [];
  let torn = 0;
  for (const entry of entries) {
    try {
      if (await resolveOne(entry, deps)) torn++;
      resolved.push(entry.path_hash);
    } catch (error) {
      log.warn("interrupted write not resolved, retrying at the next connection", {
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await deps.state.clearInterruptedWrites(resolved);
  log.info("resolved interrupted writes", {
    entries: entries.length,
    resolved: resolved.length,
    torn,
  });
}

/** One entry. True = the bytes on disk were a fragment of this device's own write. */
async function resolveOne(entry: InFlightWrite, deps: InterruptedWriteDeps): Promise<boolean> {
  const disk = await diskPlaintextHashIfPresent(entry.path, deps.apply.vault);
  if (disk === null) return false; // nothing on disk: the write never reached it
  // Nothing was written: the disk still holds the version the row already tracks.
  if (disk === deps.state.getLocalFile(entry.path)?.plaintext_hash) return false;
  const head = await deps.chainHead(entry.path_hash);
  if (head === null) {
    // No head: the server never committed this path. Heads are never compacted away, so
    // these are the copies this device makes for itself (a conflict sibling, a rejoin
    // backup) whose source content still exists: the partial copy goes, nothing is
    // committed, and the original path keeps the edit it was copied from.
    await removeVaultPath(entry.path, deps.apply.vault);
    return true;
  }
  const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, head.path_hash);
  // The write landed (it holds the head), or it completed and the commit/merge that follows
  // it never ran: those bytes are real, so they stay for the normal apply/reconciler.
  if (disk === meta.plaintext_hash || disk === entry.expected_plaintext_hash) return false;
  // Torn: the head goes over it. `isTorn` is still true for this path (the record is
  // cleared after the pass), so the apply cannot read the fragment as a local edit.
  await applyVersion(headToServerVersion(head, deps.vaultId), deps.apply);
  return true;
}
