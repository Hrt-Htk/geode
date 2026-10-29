import type { Database } from "@db/sqlite";
import { b64encode, RENAME_MARKER } from "../core/protocol.ts";
import { mapVersionRow, type VersionRow } from "./db.ts";
import { eraseHistory } from "./trash-erase.ts";

// ── Trash persistence helpers (extracted from trash.ts to keep the HTTP layer ≤300 LOC) ──

export interface TrashedHeadRow {
  path_hash: string;
  vault_id: string;
  head_json: string;
  deleted_by_device: string;
  trashed_at: number;
}

export function getVersionRecord(
  db: Database,
  vaultId: string,
  pathHash: string,
  version: number,
): VersionRow | null {
  const row = db.prepare(
    `SELECT version, parent, seq, path_hash, enc_metadata, chunk_hashes, deleted, device_id, created_at, path_ciphertext, rename_mark, restored
     FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?`,
  ).get(vaultId, pathHash, version) as Record<string, unknown> | null;
  return row ? mapVersionRow(row) : null;
}

// #583 §13 / #596: a version newer than `version` means the name moved on: later
// content (a rename note, or a newer file created after it) would be reverted by a
// restore, and a later rename marker means the name was **renamed away**: restoring
// it would resurrect a renamed-away name on every device.
export function nameMovedOn(
  db: Database,
  vaultId: string,
  pathHash: string,
  version: number,
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM file_versions
     WHERE vault_id = ? AND path_hash = ? AND version > ? AND (deleted = 0 OR rename_mark = ?)
     LIMIT 1`,
  ).get(vaultId, pathHash, version, RENAME_MARKER);
  return Boolean(row);
}

/** #679: returns the stored head's size, for the vault's budget counter. */
export function trashHead(
  db: Database,
  vaultId: string,
  pathHash: string,
  contentVersion: number,
  deletedByDevice: string,
): number {
  if (contentVersion < 1) return 0;
  const record = getVersionRecord(db, vaultId, pathHash, contentVersion);
  if (!record || record.deleted === 1) return 0;
  const pathCt = record.path_ciphertext
    ? b64encode(record.path_ciphertext as unknown as Uint8Array)
    : null;
  const headJson = JSON.stringify({
    version: record.version,
    parent: record.parent,
    chunk_hashes: JSON.parse(record.chunk_hashes),
    enc_metadata: b64encode(record.enc_metadata as unknown as Uint8Array),
    path_ciphertext: pathCt,
    deleted: 0,
  });
  const trashedAt = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at)
     VALUES(?, ?, ?, ?, ?)`,
  ).run(pathHash, vaultId, headJson, deletedByDevice, trashedAt);
  return headJson.length;
}

export function listTrash(
  db: Database,
  vaultId: string,
): Array<{
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
  path_ciphertext: string | null;
  enc_metadata: string;
  // #583: additive: the trashed head's version, the ceiling of the History
  // action on a trash row (a reused name shows only earlier versions).
  version: number;
  // #557: additive: the re-key row rewrite re-posts the head verbatim.
  head_json: string;
}> {
  const rows = db.prepare(
    `SELECT path_hash, trashed_at, deleted_by_device, head_json FROM trashed_heads
     WHERE vault_id = ? ORDER BY trashed_at DESC`,
  ).all(vaultId) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let parsed: {
      version?: number;
      path_ciphertext?: string | null;
      enc_metadata?: string;
    } = {};
    try {
      parsed = JSON.parse(r.head_json as string) as typeof parsed;
    } catch {
      // malformed head_json: leave fields null/empty
    }
    return {
      path_hash: r.path_hash as string,
      trashed_at: r.trashed_at as number,
      deleted_by_device: r.deleted_by_device as string,
      path_ciphertext: parsed.path_ciphertext ?? null,
      // #455: additive: encrypted FileMeta so the client can decrypt size/mime
      // for the preview without downloading content. The server never sees plaintext.
      enc_metadata: parsed.enc_metadata ?? "",
      version: parsed.version ?? 0,
      head_json: r.head_json as string,
    };
  });
}

export function getTrashedChunkHashes(db: Database, vaultId: string): string[] {
  const rows = db.prepare(
    "SELECT head_json FROM trashed_heads WHERE vault_id = ?",
  ).all(vaultId) as Array<{ head_json: string }>;
  return rows.flatMap((r) => (JSON.parse(r.head_json) as { chunk_hashes: string[] }).chunk_hashes);
}

export function getTrashedHead(
  db: Database,
  vaultId: string,
  pathHash: string,
): TrashedHeadRow | null {
  const row = db.prepare(
    `SELECT path_hash, vault_id, head_json, deleted_by_device, trashed_at
     FROM trashed_heads WHERE vault_id = ? AND path_hash = ?`,
  ).get(vaultId, pathHash) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    path_hash: row.path_hash as string,
    vault_id: row.vault_id as string,
    head_json: row.head_json as string,
    deleted_by_device: row.deleted_by_device as string,
    trashed_at: row.trashed_at as number,
  };
}

// #455: the trashed head's encrypted content record (chunk IDs + FileMeta), so the
// client can fetch the blobs and decrypt to this device only. Returns null when the
// path isn't in the trash.
export function getTrashedContent(
  db: Database,
  vaultId: string,
  pathHash: string,
): { chunk_hashes: string[]; enc_metadata: string } | null {
  const trashed = getTrashedHead(db, vaultId, pathHash);
  if (!trashed) return null;
  let parsed: { chunk_hashes?: string[]; enc_metadata?: string };
  try {
    parsed = JSON.parse(trashed.head_json) as typeof parsed;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.chunk_hashes) || typeof parsed.enc_metadata !== "string") {
    return null;
  }
  return {
    chunk_hashes: parsed.chunk_hashes,
    enc_metadata: parsed.enc_metadata,
  };
}

export function deleteTrashedHead(
  db: Database,
  vaultId: string,
  pathHash: string,
): boolean {
  return db.prepare(
    `DELETE FROM trashed_heads WHERE vault_id = ? AND path_hash = ?`,
  ).run(vaultId, pathHash) > 0;
}

// #582: the ceiling of a trashed row's history: the version a delete-forever erase
// may reach at this name. 0 for a malformed head (nothing is erased).
export function headCap(headJson: string): number {
  try {
    const version = (JSON.parse(headJson) as { version?: number }).version;
    return typeof version === "number" && version > 0 ? version : 0;
  } catch {
    return 0;
  }
}

/** Erase each row's own generation, then the row (#582). A renamed file writes no
 * row, so a purge never reaches its history. A row whose erase is refused (its name
 * is live again) still leaves the trash: the versions stay, nothing is lost. */
function purgeRows(
  db: Database,
  rows: Array<{ vault_id: string; path_hash: string; head_json: string }>,
): number {
  for (const row of rows) {
    const erase = eraseHistory(
      db,
      row.vault_id,
      [{ pathHash: row.path_hash, upTo: headCap(row.head_json), link: false }],
      row.path_hash,
    );
    if (!erase.ok) deleteTrashedHead(db, row.vault_id, row.path_hash);
  }
  return rows.length;
}

export function purgeExpiredTrash(
  db: Database,
  retentionSeconds: number,
  vaultId?: string,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionSeconds;
  // Vault data under a re-key session (and its staging vault) is frozen (#556):
  // purging there would lose rows the switch is about to move or resurrect.
  const frozen =
    "vault_id NOT IN (SELECT id FROM vaults WHERE rekey_mode IS NOT NULL OR rekey_of IS NOT NULL)";
  const stmt = db.prepare(
    vaultId
      ? `SELECT vault_id, path_hash, head_json FROM trashed_heads WHERE vault_id = ? AND trashed_at < ? AND ${frozen}`
      : `SELECT vault_id, path_hash, head_json FROM trashed_heads WHERE trashed_at < ? AND ${frozen}`,
  );
  const rows = (vaultId ? stmt.all(vaultId, cutoff) : stmt.all(cutoff)) as Array<{
    vault_id: string;
    path_hash: string;
    head_json: string;
  }>;
  return purgeRows(db, rows);
}

/** Purge all of a vault's trash, erasing each row's own generation (#582). */
export function purgeAllTrash(db: Database, vaultId: string): number {
  const rows = db.prepare(
    "SELECT vault_id, path_hash, head_json FROM trashed_heads WHERE vault_id = ?",
  ).all(vaultId) as Array<{ vault_id: string; path_hash: string; head_json: string }>;
  return purgeRows(db, rows);
}
