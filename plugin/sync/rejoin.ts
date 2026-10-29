// #701: the rejoin over an old copy: before the rebuild writes anything, decide per
// disk path whether the server can vouch for the bytes, and copy the ones it cannot into
// a vault folder. One reason to change: that policy.

import { b64decode, type HeadRecord, type VersionRecord } from "../../core/protocol.ts";
import { decryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { mapWithConcurrency } from "../../core/concurrency.ts";
import { blake3Hex, hashPathHex } from "../../core/hash.ts";
import { normalizeForHash } from "../../core/normalize.ts";
import { REJOIN_BACKUP_FOLDER } from "../plumbing/settings-types.ts";
import type { StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import { enumerateDisk, type EnumerateDiskVault } from "./enumerate-disk.ts";
import { readVaultBinary, type Vault, writeVaultBinary } from "./vault-io.ts";

/** Doubtful paths one rejoin asks the server about; the rest is copied unasked. */
const CHAIN_LOOKUP_LIMIT = 200;
const CHAIN_LOOKUP_CONCURRENCY = 8;

export interface RejoinBackup {
  /** Vault folder the copies went to, e.g. "Geode backup/2026.10.29 14.06.42". */
  folder: string;
  count: number;
}

export interface RejoinDeps {
  vault: Vault & EnumerateDiskVault;
  state: StateDB;
  keys: VaultKeys;
  isSyncable: (path: string) => boolean;
  /** Every live head, as the rebuild already has it: most unchanged files are answered
   * here, without a request. */
  heads: HeadRecord[];
  /** One path's whole version chain, newest first (`Transport.getVersionChain`). */
  chainOf: (pathHash: string) => Promise<VersionRecord[]>;
}

export interface RejoinPreparation {
  /** Paths whose disk bytes are not any server version AND whose row says the file was
   * synced once: a genuine edit, kept in the vault for the normal merge path. */
  edits: Set<string>;
  /** Paths the adapter could not read here: nothing could be copied out, so the rebuild
   * must keep them (never prune the only copy). */
  unreadable: string[];
  backup: RejoinBackup | null;
}

interface Doubtful {
  path: string;
  pathHash: string;
  hash: string;
  /** A live row tracks this path: its bytes differ from what was last synced. */
  live: boolean;
}

/** "2026.10.29 14.06.42": plain, sortable, and dash free like all user-visible text. */
export function rejoinStamp(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${at.getFullYear()}.${pad(at.getMonth() + 1)}.${pad(at.getDate())} ` +
    `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
}

/** The classification and the copies. Bytes the server already holds: at the path's head,
 * or as one of its versions: are a copy of something synced: the server version wins and
 * nothing is copied. Anything else is either a real edit (a live row: kept, merged later)
 * or doubtful (no row or a closed one: copied out, then the server wins). */
export async function prepareRejoin(deps: RejoinDeps): Promise<RejoinPreparation> {
  const { doubtful, unreadable } = await collectDoubtful(deps);
  const headHashes = await readHeadHashes(deps);
  // The head answers the unchanged files for free; whatever it cannot answer is a stale
  // copy of an older version (or an edit), so one chain request per remaining path.
  const rest = doubtful.filter((c) => headHashes.get(c.pathHash) !== c.hash);
  const asked = rest.slice(0, CHAIN_LOOKUP_LIMIT);
  const answers = await mapWithConcurrency(
    asked,
    CHAIN_LOOKUP_CONCURRENCY,
    (candidate) => chainKnows(candidate, deps),
  );
  const known = new Map(asked.map((candidate, i) => [candidate.path, answers[i]]));

  const edits = new Set<string>();
  const backup: Doubtful[] = [];
  for (const candidate of doubtful) {
    if (headHashes.get(candidate.pathHash) === candidate.hash) continue;
    if (known.get(candidate.path) === true) continue;
    if (candidate.live) {
      edits.add(candidate.path);
      continue;
    }
    backup.push(candidate);
  }

  const result = backup.length === 0 ? null : await writeBackup(backup, deps);
  log.info("rejoin prepared", {
    doubtfulPaths: doubtful.length,
    capped: rest.length - asked.length,
    edits: edits.size,
    unreadable: unreadable.length,
    backedUp: result?.count ?? 0,
    folder: result?.folder ?? null,
  });
  return { edits, unreadable, backup: result };
}

/** Each live head's content hash, by path hash. One decryption per path, no request: the
 * rebuild fetched the heads anyway. An unreadable head answers nothing (its path falls
 * through to the chain). */
async function readHeadHashes(deps: RejoinDeps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const head of deps.heads) {
    if (head.deleted) continue;
    try {
      const meta = await decryptMetadata(b64decode(head.enc_metadata), deps.keys, head.path_hash);
      out.set(head.path_hash, meta.plaintext_hash);
    } catch {
      // an unreadable head vouches for nothing
    }
  }
  return out;
}

/** Every in-scope disk path whose bytes are not the ones its live row recorded, plus the
 * paths the adapter refused (they go to `unreadable`: nothing can be copied out). */
async function collectDoubtful(
  deps: RejoinDeps,
): Promise<{ doubtful: Doubtful[]; unreadable: string[] }> {
  const disk = new Set<string>();
  await enumerateDisk(deps.vault, "", disk, {});
  const doubtful: Doubtful[] = [];
  const unreadable: string[] = [];
  for (const path of disk) {
    if (!deps.isSyncable(path)) continue;
    const bytes = await readVaultBinary(path, deps.vault);
    if (bytes === null) {
      unreadable.push(path);
      continue;
    }
    const hash = blake3Hex(normalizeForHash(path, bytes));
    const pathHash = hashPathHex(deps.keys.mac_key, path);
    const row = deps.state.getLocalFile(path);
    if (row && !row.deleted) {
      if (hash === row.plaintext_hash) continue; // untouched since the last sync
      doubtful.push({ path, pathHash, hash, live: true });
      continue;
    }
    doubtful.push({ path, pathHash, hash, live: false });
  }
  return { doubtful, unreadable };
}

/** Is one of the path's server versions exactly these bytes? The newest page of the chain
 * is the answer for every plausible case; deeper history or an unreadable chain counts as
 * unknown, which only ever sends bytes to the backup folder. */
async function chainKnows(candidate: Doubtful, deps: RejoinDeps): Promise<boolean> {
  try {
    for (const record of await deps.chainOf(candidate.pathHash)) {
      const meta = await decryptMetadata(
        b64decode(record.enc_metadata),
        deps.keys,
        candidate.pathHash,
      );
      if (meta.plaintext_hash === candidate.hash) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function writeBackup(copies: Doubtful[], deps: RejoinDeps): Promise<RejoinBackup> {
  const folder = `${REJOIN_BACKUP_FOLDER}/${rejoinStamp(Date.now())}`;
  let written = 0;
  for (const copy of copies) {
    const bytes = await readVaultBinary(copy.path, deps.vault);
    if (bytes === null) continue;
    await writeVaultBinary(`${folder}/${copy.path}`, bytes, Date.now(), deps.vault);
    written++;
  }
  log.info("rejoin backed up doubtful files", { folder, count: written });
  return { folder, count: written };
}
