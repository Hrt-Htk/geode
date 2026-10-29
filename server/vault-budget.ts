// #679: the per-vault storage budget (docs/architecture/server.md §4).
import type { Database } from "@db/sqlite";
import type { ClientCommit } from "../core/protocol.ts";
import { vaultBlobBytes } from "./blobs.ts";
import { headIsLive } from "./db.ts";
import { envNum } from "./env.ts";
import { log } from "./log.ts";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024 * 1024; // 20 GiB

export function vaultMaxBytes(): number {
  return Math.max(0, envNum("GEODE_VAULT_MAX_BYTES") ?? DEFAULT_MAX_BYTES);
}

// CAST: a 64-bit INTEGER reads back truncated to 32 bits (see db.ts).
export function vaultBytes(db: Database, vaultId: string): number {
  const row = db.prepare(
    "SELECT CAST(stored_bytes AS REAL) AS n FROM vaults WHERE id = ?",
  ).get(vaultId) as { n: number } | null;
  return row?.n ?? 0;
}

/** The bytes a version row stores: enc_metadata, path_ciphertext, chunk_hashes JSON. */
export function rowBytes(
  encMetadata: Uint8Array,
  pathCiphertext: Uint8Array | null,
  chunkHashes: string[],
): number {
  return encMetadata.length + (pathCiphertext?.length ?? 0) + JSON.stringify(chunkHashes).length;
}

// The same payload columns SUM over the vault, plus the serialized heads it trashes.
// CAST for the same 32-bit read reason as vaultBytes.
function storedRowBytes(db: Database, vaultId: string): number {
  const row = db.prepare(
    `SELECT CAST(
       COALESCE((SELECT SUM(length(enc_metadata) + COALESCE(length(path_ciphertext), 0)
                            + length(chunk_hashes))
                 FROM file_versions WHERE vault_id = ?), 0)
       + COALESCE((SELECT SUM(length(head_json)) FROM trashed_heads WHERE vault_id = ?), 0)
       AS REAL) AS n`,
  ).get(vaultId, vaultId) as { n: number } | null;
  return row?.n ?? 0;
}

/** Re-count a vault from what is stored: startup, after a re-key swap, after compaction. */
export function measureVault(db: Database, dataDir: string, vaultId: string): number {
  const bytes = vaultBlobBytes(dataDir, vaultId) + storedRowBytes(db, vaultId);
  db.run("UPDATE vaults SET stored_bytes = ? WHERE id = ?", bytes, vaultId);
  return bytes;
}

/** Re-measure, but never fail the caller: a re-key switch has already committed when this
 * runs, and a counter that could not be walked is corrected by the next measure. */
export function tryMeasureVault(db: Database, dataDir: string, vaultId: string): void {
  try {
    measureVault(db, dataDir, vaultId);
  } catch (e) {
    log.error("vault re-measure failed", { vault_id: vaultId, error: (e as Error).message });
  }
}

/** Apply a write's byte delta. Relative, so concurrent writers cannot lose each other's. */
export function addVaultBytes(db: Database, vaultId: string, delta: number): void {
  if (delta === 0) return;
  db.run("UPDATE vaults SET stored_bytes = MAX(0, stored_bytes + ?) WHERE id = ?", delta, vaultId);
}

export function vaultOverBudget(db: Database, vaultId: string): boolean {
  return vaultBytes(db, vaultId) >= vaultMaxBytes();
}

/** What a vault past its budget still accepts: a plain tombstone of a live head, the
 * only commit that frees bytes (GC drops its blobs later). Everything else adds rows. */
export function overBudgetRefusal(db: Database, vaultId: string, msg: ClientCommit): boolean {
  if (!vaultOverBudget(db, vaultId)) return false;
  if (!msg.deleted) return true;
  const plain = Array.isArray(msg.chunk_hashes) && msg.chunk_hashes.length === 0;
  return !plain || !headIsLive(db, vaultId, msg.path_hash);
}
