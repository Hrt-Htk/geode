// #465: restore a past version: write its reconstructed bytes at the file's
// CURRENT name and append them as a NEW head version. History is never rewritten,
// so the content the restore replaces stays a version. The confirm copy's promise
// holds: an edit that never reached the server is committed as its own version
// first. The appended row is plain content, never a rename link (hard rule 6).

import { decryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { blake3Hex } from "../../core/hash.ts";
import { normalizeForHash } from "../../core/normalize.ts";
import { b64decode, RENAME_MARKER, type VersionRecord } from "../../core/protocol.ts";
import type { StateDB } from "../plumbing/state.ts";
import type { ActivityRecord } from "./activity-log.ts";
import {
  commitFileBytes,
  commitOp,
  type Vault as CommitVault,
  waitForInFlightCommit,
} from "./commit.ts";
import { reconstructVersion } from "./history-fetch.ts";
import type { Transport } from "./transport.ts";
import { readVaultBinary, writeVaultBinary } from "./vault-io.ts";

export type RestoreOutcome = "restored" | "unchanged";

/** A same-path commit is still running: the restore must not be dropped by
 * commitOp's dedup, so it asks the user to try again. */
export class RestoreBusy extends Error {}

/** Sync is paused: no commit can land, so the restore would overwrite the disk
 * without the current content ever becoming a version. */
export class RestorePaused extends Error {}

/** The bytes are on disk but the commit did not land (offline): the event layer
 * re-commits them later, so this is not a failure of the content. */
export class RestoreUnsynced extends Error {}

/** Renames since the window opened; a chain, not a history: bound the walk. */
const MAX_RENAME_HOPS = 10;

type RestoreVault = CommitVault & {
  adapter:
    & CommitVault["adapter"]
    & Required<
      Pick<CommitVault["adapter"], "readBinary" | "exists" | "stat">
    >;
};

export interface RestoreDeps {
  vault: RestoreVault;
  state: StateDB;
  keys: VaultKeys;
  transport: Transport;
  onConflict: (
    path: string,
    head: { path_hash: string; version: number },
  ) => Promise<void> | void;
  recordActivity?: ActivityRecord;
  deviceId?: string;
  deviceName?: string;
  suppressSelfWrite?: (path: string) => void;
  /** #697: pair marks of this device's own applied renames. */
  suppressSelfRename?: (from: string, to: string) => () => void;
}

/** Restore `record`'s content at `path`: the name the file has NOW, even when the
 * version predates a rename. Returns "unchanged" when the disk already holds it. */
export async function restoreVersion(
  record: VersionRecord,
  path: string,
  deps: RestoreDeps,
): Promise<RestoreOutcome> {
  const { bytes } = await reconstructVersion(
    record,
    deps.keys,
    (hash) => deps.transport.getBlob(hash),
  );
  // Owner decision 8: a window opened before a rename must not write the file
  // back under its old name: the restore lands where the file is now.
  const target = await currentName(path, deps);
  const restoredHash = blake3Hex(normalizeForHash(target, bytes));
  if (await diskHash(target, deps) === restoredHash) return "unchanged";
  // A same-path commit starting mid-restore reads the pre-restore bytes, and
  // commitOp dedups ours silently: the ROW hash: not commitOp's boolean: decides
  // success, and a failed pass retries once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await settleAndPreserve(target, deps);
    await settleAndPreserve(target, deps);
    await writeVaultBinary(target, bytes, Date.now(), deps.vault);
    if (!(await commitOp({ path: target, kind: "commit" }, commitDeps(deps)))) {
      throw new RestoreUnsynced(target);
    }
    if (deps.state.getLocalFile(target)?.plaintext_hash === restoredHash) {
      deps.recordActivity?.({ path: target, kind: "restore" });
      return "restored";
    }
  }
  throw new RestoreBusy(target);
}

async function diskHash(path: string, deps: RestoreDeps): Promise<string | null> {
  const disk = await readVaultBinary(path, deps.vault);
  return disk === null ? null : blake3Hex(normalizeForHash(path, disk));
}

/** No same-path commit may be running (commitOp would dedup it), and whatever the
 * disk holds NOW: a save that landed during the wait included: becomes a version
 * of its own before the restore overwrites it. Called twice per pass because the
 * settle itself can wait 5 s. */
async function settleAndPreserve(path: string, deps: RestoreDeps): Promise<void> {
  if (!(await waitForInFlightCommit(deps.state, path))) throw new RestoreBusy(path);
  const disk = await readVaultBinary(path, deps.vault);
  if (disk === null) return;
  const stat = await deps.vault.adapter.stat(path).catch(() => null);
  const saved = await commitFileBytes(path, disk, stat?.mtime ?? Date.now(), commitDeps(deps));
  if (!saved) throw new Error(`failed to save the current content of ${path} first`);
}

/** The name the file has now: the row for `path` closed by a rename marker points
 * at the next name, and a restored version follows it (owner decision 8). A row
 * closed by a plain delete keeps its name: that is a deleted file, not a move. */
async function currentName(path: string, deps: RestoreDeps): Promise<string> {
  let target = path;
  for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
    const next = await renamedTarget(target, deps);
    if (next === null) return target;
    target = next;
  }
  return target;
}

async function renamedTarget(path: string, deps: RestoreDeps): Promise<string | null> {
  const row = deps.state.getLocalFile(path);
  if (!row?.deleted || row.last_seen_version === 0) return null;
  const head = (await deps.transport.getVersionChain(row.path_hash))[0];
  if (head?.rename_mark !== RENAME_MARKER) return null;
  const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, row.path_hash);
  return meta.renamed_to ?? null;
}

function commitDeps(deps: RestoreDeps) {
  return {
    vault: deps.vault,
    state: deps.state,
    keys: deps.keys,
    transport: deps.transport,
    onConflict: deps.onConflict,
    recordActivity: deps.recordActivity,
    deviceId: deps.deviceId,
    deviceName: deps.deviceName,
    suppressSelfWrite: deps.suppressSelfWrite,
    suppressSelfRename: deps.suppressSelfRename,
    // The target is resolved up front (a rename since the window opened follows to
    // the file's current name), so no queued rename of this device moves under it.
    pendingRenameTarget: () => undefined,
  };
}
