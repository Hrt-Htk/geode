export type { Database } from "@db/sqlite";
import { Database } from "@db/sqlite";

const MIGRATION_RE = /^(\d{3})_/;

function readMigrations(migrationsDir: string): Array<{ num: number; path: string }> {
  const migrations: Array<{ num: number; path: string }> = [];
  for (const entry of Deno.readDirSync(migrationsDir)) {
    const m = MIGRATION_RE.exec(entry.name);
    if (m && entry.isFile) {
      migrations.push({ num: parseInt(m[1], 10), path: `${migrationsDir}/${entry.name}` });
    }
  }
  migrations.sort((a, b) => a.num - b.num);
  return migrations;
}

function runMigrations(db: Database, migrationsDir: string): void {
  const migrations = readMigrations(migrationsDir);
  let current = 0;
  try {
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    current = parseInt(row.value, 10);
  } catch (e) {
    // Only a missing _meta table means fresh DB; any other read error must
    // propagate, not be mistaken for a fresh DB (which would re-run migrations).
    if (!(e instanceof Error && e.message.includes("no such table"))) throw e;
  }

  for (const mig of migrations) {
    if (mig.num <= current) continue;
    const sql = Deno.readTextFileSync(mig.path);
    // Apply the migration and its version bump atomically so a failure rolls
    // back both the DDL and the bump: no partial schema or version state.
    db.transaction(() => {
      db.exec(sql);
      db.run(`UPDATE _meta SET value = '${mig.num}' WHERE key = 'schema_version'`);
    })();
  }
}

export function openDb(
  dataDir: string,
  migrationsDir = `${import.meta.dirname}/../db/migrations`,
): Database {
  const dbPath = `${dataDir}/geode.db`;
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db, migrationsDir);
  return db;
}
// ── Prepared query helpers ────────────────────────────────────────────

// `created_at` is a millisecond stamp (~1.8e12), and the FFI driver reads INTEGER
// columns as 32-bit, so every SELECT that hands a version row to a client must
// CAST it to REAL: otherwise the client sees a 1970 date (#464).
export function mapVersionRow(r: Record<string, unknown>): VersionRow {
  return {
    version: r.version as number,
    parent: r.parent as number | null,
    seq: r.seq as number,
    path_hash: r.path_hash as string,
    enc_metadata: r.enc_metadata as Uint8Array,
    chunk_hashes: r.chunk_hashes as string,
    deleted: r.deleted as number,
    device_id: r.device_id as string,
    created_at: r.created_at as number,
    compacted_range: r.compacted_range as string | null,
    path_ciphertext: r.path_ciphertext as Uint8Array | null,
    rename_mark: (r.rename_mark as number | undefined) ?? 0,
    restored: (r.restored as number | undefined) ?? 0,
  };
}
export interface HeadRow {
  path_hash: string;
  version: number;
  seq: number;
  enc_metadata: Uint8Array;
  chunk_hashes: string[];
  deleted: number;
  path_ciphertext: Uint8Array | null;
  rename_mark: number;
}
export interface VersionRow {
  version: number;
  parent: number | null;
  seq: number;
  path_hash: string;
  enc_metadata: Uint8Array | string;
  chunk_hashes: string;
  deleted: number;
  device_id: string;
  created_at: number;
  compacted_range: string | null;
  path_ciphertext: Uint8Array | null;
  /** #583: 0 = ordinary version, RENAME_MARKER | RENAME_NOTE. */
  rename_mark: number;
  /** #687: 1 = restored from the trash: the authoring device applies it too. */
  restored: number;
}
export interface InsertResult {
  version: number;
  seq: number;
}
export interface ConflictResult {
  conflict: true;
  currentHead: number;
}
export function insertVersion(
  db: Database,
  vaultId: string,
  pathHash: string,
  parentVersion: number,
  encMetadata: Uint8Array,
  chunkHashes: string[],
  deleted: boolean,
  deviceId: string,
  pathCiphertext?: Uint8Array | null,
  renameMark = 0,
  restored = 0,
): InsertResult | ConflictResult {
  const chunkHashesJson = JSON.stringify(chunkHashes);
  const deletedInt = deleted ? 1 : 0;
  const createdAt = Date.now();
  const fn = db.transaction(() => {
    const head = db.prepare(
      "SELECT MAX(version) AS v FROM file_versions WHERE vault_id = ? AND path_hash = ?",
    ).get(vaultId, pathHash) as { v: number | null };
    const currentHead = head.v ?? 0;
    if (parentVersion !== currentHead) {
      return { conflict: true as const, currentHead };
    }
    const counter = db.prepare(
      "INSERT INTO seq_counters(vault_id, next_seq) VALUES(?, 1) ON CONFLICT(vault_id) DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq",
    ).get(vaultId) as { next_seq: number };
    const newSeq = counter.next_seq;
    const newVersion = currentHead + 1;
    db.prepare(
      `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at, path_ciphertext, rename_mark, restored)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      vaultId,
      pathHash,
      newVersion,
      newSeq,
      parentVersion,
      encMetadata,
      chunkHashesJson,
      deletedInt,
      deviceId,
      createdAt,
      pathCiphertext ?? null,
      renameMark,
      restored,
    );
    return { version: newVersion, seq: newSeq };
  });
  return fn();
}
export function getCurrentHeadVersion(
  db: Database,
  vaultId: string,
  pathHash: string,
): number | null {
  const row = db.prepare(
    "SELECT MAX(version) AS v FROM file_versions WHERE vault_id = ? AND path_hash = ?",
  ).get(vaultId, pathHash) as { v: number | null };
  return row.v;
}
export function* getHeadsAfter(
  db: Database,
  vaultId: string,
  afterSeq: number,
): Generator<HeadRow> {
  const stmt = db.prepare(
    `WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY path_hash ORDER BY version DESC) AS rn
      FROM file_versions WHERE vault_id = ?
    )
    SELECT path_hash, version, seq, enc_metadata, chunk_hashes, deleted, path_ciphertext, rename_mark
    FROM ranked WHERE rn = 1 AND (deleted = 0 OR seq > ?)
    ORDER BY seq`,
  );
  for (const row of stmt.iter(vaultId, afterSeq)) {
    yield {
      path_hash: row.path_hash as string,
      version: row.version as number,
      seq: row.seq as number,
      enc_metadata: row.enc_metadata as Uint8Array,
      chunk_hashes: JSON.parse(row.chunk_hashes as string) as string[],
      deleted: row.deleted as number,
      path_ciphertext: row.path_ciphertext as Uint8Array | null,
      rename_mark: (row.rename_mark as number | undefined) ?? 0,
    };
  }
}
export function getVersionChain(
  db: Database,
  vaultId: string,
  pathHash: string,
  upTo: number,
  afterVersion?: number,
): VersionRow[] {
  let sql = `
    SELECT version, parent, seq, path_hash, enc_metadata, chunk_hashes, deleted, device_id, CAST(created_at AS REAL) AS created_at, compacted_range, path_ciphertext, rename_mark, restored
    FROM file_versions
    WHERE vault_id = ? AND path_hash = ? AND version <= ?
  `;
  const params: unknown[] = [vaultId, pathHash, upTo];
  if (afterVersion !== undefined) {
    sql += " AND version >= ?";
    params.push(afterVersion);
  }
  sql += " ORDER BY version DESC LIMIT 100";
  const stmt = db.prepare(sql);
  const rows = stmt.all(...(params as Array<import("@db/sqlite").BindValue>)) as Array<
    Record<string, unknown>
  >;
  return rows.map(mapVersionRow);
}
export function* getReplaySince(
  db: Database,
  vaultId: string,
  lastSeenSeq: number,
): Generator<VersionRow> {
  const stmt = db.prepare(
    `SELECT version, parent, seq, path_hash, enc_metadata, chunk_hashes, deleted, device_id, CAST(created_at AS REAL) AS created_at, compacted_range, path_ciphertext, rename_mark, restored
     FROM file_versions WHERE vault_id = ? AND seq > ? ORDER BY seq`,
  );
  for (const row of stmt.iter(vaultId, lastSeenSeq)) {
    yield mapVersionRow(row);
  }
}

// Per-device applied position (the device's sync cursor), reported over the WS
// after the device applies a catch-up (#433). Best-effort, like last_seen_at.
export function setDeviceAppliedSeq(db: Database, deviceId: string, seq: number): void {
  db.run("UPDATE devices SET applied_seq = ? WHERE id = ?", seq, deviceId);
}

// #679: past the storage budget only a tombstone that flips a live head is accepted,
// so this asks the current head, not "was this path ever live".
export function headIsLive(db: Database, vaultId: string, pathHash: string): boolean {
  const row = db.prepare(
    "SELECT deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
  ).get(vaultId, pathHash) as { deleted: number } | undefined;
  return row?.deleted === 0;
}

// Active re-key mode for a vault (#556): "copy" | "replace" | null. While set,
// WS commits and normal blob PUTs are refused.
export function rekeyMode(db: Database, vaultId: string): string | null {
  const row = db.prepare("SELECT rekey_mode FROM vaults WHERE id = ?").get(vaultId) as {
    rekey_mode: string | null;
  } | null;
  return row?.rekey_mode ?? null;
}
