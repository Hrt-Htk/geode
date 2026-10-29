import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../../core/normalize.ts";
import {
  b64decode,
  HeadRecord,
  headToServerVersion,
  type VersionRecord,
} from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import { reassemble } from "../../core/reassemble.ts";
import { mapWithConcurrency } from "../../core/concurrency.ts";
import { hashPathHex } from "../../core/hash.ts";
import { applyVersion } from "./apply.ts";
import type { PendingMoveOut } from "../plumbing/scope-pending.ts";
import { removeVaultPath, type Vault } from "./vault-io.ts";
import { log } from "../plumbing/log.ts";
import { StateDB } from "../plumbing/state.ts";
import { enumerateDisk, type EnumerateDiskVault } from "./enumerate-disk.ts";
import { prepareRejoin, type RejoinBackup, type RejoinPreparation } from "./rejoin.ts";

type HeadTransport = {
  getBlob: (hash: string) => Promise<Uint8Array>;
  getHeads: (afterSeq: number) => AsyncGenerator<HeadRecord>;
  getVersionChain: (pathHash: string) => Promise<VersionRecord[]>;
};

type ProgressInfo = {
  current: number;
  total: number;
};

export interface ResyncDeps {
  vault: Vault & EnumerateDiskVault;
  transport: HeadTransport;
  state: StateDB;
  keys: VaultKeys;
  vaultId: string;
  isSyncable: (path: string) => boolean;
  /** #584: the moves this device parked in an excluded folder: their names are out of
   * scope for the rebuild and their closed rows are seeded back from the heads. */
  parkedMoves?: () => PendingMoveOut[];
  /** #701: a join landed on an old copy of this vault: the server wins for every path
   * the device did not change, and the bytes it cannot vouch for are copied out first. */
  rejoin?: boolean;
  onProgress?: (progress: ProgressInfo) => void;
}

export interface ExportDeps {
  transport: HeadTransport;
  keys: VaultKeys;
  onProgress?: (progress: ProgressInfo) => void;
}

export interface RecoveryStats {
  totalHeads: number;
  appliedFiles: number;
  deletedFiles: number;
  latestSeq: number;
  /** #701: where a rejoin put the bytes it could not vouch for; null otherwise. */
  backup: RejoinBackup | null;
}

export interface ExportStats {
  totalHeads: number;
  exportedFiles: number;
  latestSeq: number;
}

const RECOVERY_DEVICE_ID = "__geode_recovery__";

const HEAD_APPLY_LIMIT = 8;

export async function rebuildFromScratch(deps: ResyncDeps): Promise<RecoveryStats> {
  const heads = await readCurrentHeads(deps.transport);
  // #701: a rejoin copies what the server cannot vouch for out of the vault before the
  // heads overwrite or remove it, keeps a real edit in place, and keeps an unreadable file
  // it could not copy. `kept` is never pruned (#590).
  const prepared = deps.rejoin
    ? await prepareRejoin({
      vault: deps.vault,
      state: deps.state,
      keys: deps.keys,
      isSyncable: deps.isSyncable,
      heads,
      chainOf: (pathHash) => deps.transport.getVersionChain(pathHash),
    })
    : null;
  /** Never pruned: an unreadable file could not be copied out (#590, #701). */
  const kept = new Set<string>(prepared?.unreadable ?? []);
  /** Bytes this rebuild vouches for as this device's own (a rejoin trusts only these). */
  const trusted = new Set<string>(prepared?.edits ?? []);
  const failures: string[] = [];
  // #584: before the head loop: a park whose row is missing gets its closed anchor back,
  // so the loop below skips the parked name instead of rewriting it to disk.
  reanchorParkedMoves(deps, heads);

  const onLocalEdit = keepAndTrust(kept, trusted);
  const isTrusted = trustPolicy(prepared, trusted);

  // Heads are independent per path_hash: apply with bounded concurrency.
  // Each applyVersion advances its own sync cursor; we take the max at the end.
  const indexedHeads = heads.map((h, i) => ({ head: h, index: i }));
  let appliedFiles = 0;
  let deletedFiles = 0;
  await mapWithConcurrency(
    indexedHeads,
    HEAD_APPLY_LIMIT,
    async ({ head, index }) => {
      deps.onProgress?.({ current: index + 1, total: heads.length });
      try {
        await applyHead(head, deps, onLocalEdit, isTrusted);
        if (head.deleted) deletedFiles++;
        else appliedFiles++;
      } catch (err) {
        failures.push(head.path_hash);
        log.error("resync head failed", {
          path_hash: head.path_hash,
          seq: head.seq,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await yieldToUi(index);
    },
  );

  // A failed head is a permanent (post-retry) fetch/apply failure. Do NOT prune
  // or advance the cursor on a partial resync: that would delete files and skip
  // the failed head forever. Surface it; the user retries.
  if (failures.length > 0) {
    log.error("resync failed", { failures: failures.length, paths: failures });
    throw new Error(
      `resync failed for ${failures.length} file(s): ${failures.join(", ")}`,
    );
  }

  await pruneExtraneousFiles(deps, kept);
  const latestSeq = heads.at(-1)?.seq ?? 0;
  const cursorBefore = deps.state.getSyncCursor();
  if (deps.state.getSyncCursor() < latestSeq) {
    deps.state.updateSyncCursor(latestSeq);
  }
  log.info("resync rebuilt local state", {
    totalHeads: heads.length,
    appliedFiles,
    deletedFiles,
    latestSeq,
    cursorBefore,
    cursorAfter: deps.state.getSyncCursor(),
    localFileCount: deps.state.getAllLocalFiles().size,
    backedUp: prepared?.backup?.count ?? 0,
  });

  return {
    totalHeads: heads.length,
    appliedFiles,
    deletedFiles,
    latestSeq,
    backup: prepared?.backup ?? null,
  };
}

/** A path apply keeps as a local edit is neither pruned nor diverged-over later. */
function keepAndTrust(
  kept: Set<string>,
  trusted: Set<string>,
): (path: string) => void {
  return (path) => {
    kept.add(path);
    trusted.add(path);
  };
}

/** A rejoin trusts only the bytes it vouched for; every other rebuild trusts the disk. */
function trustPolicy(
  prepared: RejoinPreparation | null,
  trusted: Set<string>,
): ((path: string) => boolean) | undefined {
  return prepared === null ? undefined : (path) => trusted.has(path);
}

/** One head → disk, under the rebuild's rules. Everything a rebuild may not trust from
 * this device is answered here, never by the live session's policy. */
async function applyHead(
  head: HeadRecord,
  deps: ResyncDeps,
  onLocalEdit: (path: string) => void,
  isTrusted: ((path: string) => boolean) | undefined,
): Promise<void> {
  await applyVersion(headToServerVersion(head, deps.vaultId), {
    vault: deps.vault,
    state: deps.state,
    keys: deps.keys,
    getBlob: (hash) => deps.transport.getBlob(hash),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: onLocalEdit,
    suppressSelfWrite: () => {},
    myDeviceId: RECOVERY_DEVICE_ID,
    isSyncable: deps.isSyncable,
    // #584: a parked name is never written back: it is out of scope like #342's.
    isParkedMove: (path) => (deps.parkedMoves?.() ?? []).some((m) => m.oldPath === path),
    // Nothing is pending during a rebuild: no rename or delete is in flight.
    pendingRenameTarget: () => undefined,
    // A rebuild must restore what the server holds even for a path this device
    // already tracks: a note deleted from disk while the app was closed has no
    // other way back. `force` re-applies an equal version; a divergent local edit
    // is still promoted (and kept) by apply's own divergence check.
    force: true,
    // #701: a rejoin trusts only bytes it vouched for: the edits prepareRejoin found, plus
    // whatever this rebuild has kept since (a rename marker's carry writes its edit at the
    // destination while that head is in flight). Everything else the server cannot vouch
    // for is in the backup folder, so the server version wins: a delete included.
    trustDiskDivergence: isTrusted,
    // #701 review: heads apply in parallel here, so the disk can change between apply's
    // read and its write (a rename's carried edit landing): re-read before writing.
    recheckDiskBeforeWrite: true,
  });
}

/** #584: a parked move's row is its anchor: the marker's parent version, the "still
 * closed" test, and `pruneMoveOuts`'s has-row check. The rebuild skips the parked name,
 * so a state without that row (a fresh one, a lost local-files.json) gets it seeded closed
 * from the server head: the park stays resolvable and the name is never rewritten to
 * disk. An existing row is left alone: it holds the version this device last saw, which
 * is what makes a peer's edit to the parked name conflict (and be carried over) instead
 * of being silently skipped as "already at the head". */
function reanchorParkedMoves(deps: ResyncDeps, heads: HeadRecord[]): void {
  const parked = deps.parkedMoves?.() ?? [];
  if (parked.length === 0) return;
  const byHash = new Map(heads.map((head) => [head.path_hash, head]));
  for (const move of parked) {
    if (deps.state.getLocalFile(move.oldPath)) continue;
    const pathHash = hashPathHex(deps.keys.mac_key, move.oldPath);
    const head = byHash.get(pathHash);
    if (!head || head.deleted) continue;
    deps.state.closeLocalRow(move.oldPath, pathHash, head.version);
  }
}

export async function exportDecryptedVault(
  targetDir: string,
  deps: ExportDeps,
): Promise<ExportStats> {
  const heads = await readCurrentHeads(deps.transport);
  let exportedFiles = 0;

  for (let index = 0; index < heads.length; index++) {
    deps.onProgress?.({ current: index + 1, total: heads.length });
    const head = heads[index];
    if (head.deleted) {
      await yieldToUi(index);
      continue;
    }

    const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, head.path_hash);
    const bytes = await reassemble(
      head.chunk_hashes,
      deps.keys,
      (hash) => deps.transport.getBlob(hash),
      meta.plaintext_hash,
    );
    const destination = path.join(targetDir, ...normalizePath(meta.path).split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    exportedFiles++;
    await yieldToUi(index);
  }

  const latestSeq = heads.at(-1)?.seq ?? 0;
  log.info("exported decrypted vault", {
    totalHeads: heads.length,
    exportedFiles,
    latestSeq,
    targetDir,
  });
  return {
    totalHeads: heads.length,
    exportedFiles,
    latestSeq,
  };
}

async function readCurrentHeads(transport: HeadTransport): Promise<HeadRecord[]> {
  const heads: HeadRecord[] = [];
  for await (const head of transport.getHeads(0)) {
    heads.push(head);
  }
  heads.sort((left, right) => left.seq - right.seq);
  return heads;
}

/** Remove the files the server closed (a delete or a rename marker) that this device
 * still has. A file with no closed row was never uploaded: a create the mass-delete
 * guard held before its first commit, so it is kept; the reconciler commits it once
 * the pass runs (#583). #701: except on a rejoin: there the server is the truth, and a
 * file it does not hold was copied to the backup folder already. */
export async function pruneExtraneousFiles(
  deps: ResyncDeps,
  keep: ReadonlySet<string> = new Set(),
): Promise<void> {
  const diskPaths = new Set<string>();
  await enumerateDisk(deps.vault, "", diskPaths, {});

  for (const normalized of diskPaths) {
    if (!deps.isSyncable(normalized)) {
      continue;
    }
    if (keep.has(normalized)) {
      continue; // a local edit the rebuild could not apply: the session merges it
    }
    const local = deps.state.getLocalFile(normalized);
    if (local && !local.deleted) {
      continue; // tracked live: the heads own this file
    }
    if (!local && !deps.rejoin) {
      continue; // never synced at all: never the server's to remove
    }
    await removeVaultPath(normalized, deps.vault).catch(() => {});
  }
}

async function yieldToUi(index: number): Promise<void> {
  if ((index + 1) % 5 !== 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
