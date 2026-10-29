import type { Database } from "@db/sqlite";
import { planCompaction } from "../core/compact.ts";
import { gcUnreferencedBlobs } from "./blobs.ts";
import { getTrashedChunkHashes, purgeExpiredTrash } from "./trash-db.ts";
import { rekeyMode } from "./db.ts";
import { envNum } from "./env.ts";
import { measureVault } from "./vault-budget.ts";
import { log } from "./log.ts";

const THROTTLE_MS = envNum("GEODE_COMPACT_THROTTLE_MS") ?? 60 * 60 * 1000; // once per hour per vault
const FLOOR_MS = (envNum("GEODE_COMPACT_FLOOR_DAYS") ?? 30) * 24 * 3600 * 1000; // older than 30 days folds
const GC_GRACE_MS = 24 * 3600 * 1000; // don't GC blobs newer than 24h
export const TRASH_RETENTION_DAYS = Math.max(0, envNum("GEODE_TRASH_RETENTION_DAYS") ?? 30);

// Per-vault timestamp of the last scheduled compaction (throttle state).
export const lastRun = new Map<string, number>();

export function maybeScheduleCompaction(
  db: Database,
  dataDir: string,
  vaultId: string,
): void {
  // Cheap gate: idle vaults with no old versions never compact.
  const cutoff = Date.now() - FLOOR_MS;
  const hasOld = db.prepare(
    "SELECT 1 FROM file_versions WHERE vault_id = ? AND created_at < ? LIMIT 1",
  ).get(vaultId, cutoff);
  if (!hasOld) return;

  const now = Date.now();
  if (now - (lastRun.get(vaultId) ?? 0) < THROTTLE_MS) return;
  lastRun.set(vaultId, now);

  // Schedule off the commit path so the client-visible write is not blocked.
  setTimeout(() => {
    runCompaction(db, dataDir, vaultId).catch((e) => {
      log.warn("compaction failed", { vault_id: vaultId, error: (e as Error).message });
    });
  }, 0);
}

export async function runCompaction(
  db: Database,
  dataDir: string,
  vaultId: string,
): Promise<{ dropped: number; gc: number }> {
  // A pass armed before a re-key session started must not drop rows a replace
  // batch will target (#556).
  if (rekeyMode(db, vaultId) !== null) {
    log.info("compaction skipped: rekey in progress", { vault_id: vaultId });
    return { dropped: 0, gc: 0 };
  }
  const paths = db.prepare(
    "SELECT DISTINCT path_hash FROM file_versions WHERE vault_id = ?",
  ).all(vaultId) as Array<{ path_hash: string }>;

  let dropped = 0;
  for (const { path_hash } of paths) {
    const rows = db.prepare(
      // CAST to REAL: the sqlite driver truncates 64-bit ints to 32-bit on
      // read, which would corrupt ms timestamps (> 2^31); a REAL read is exact.
      "SELECT version, CAST(created_at AS REAL) AS created_at, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version ASC",
    ).all(vaultId, path_hash) as Array<
      { version: number; created_at: number; rename_mark: number }
    >;
    const plan = planCompaction(rows, Date.now(), { floorMs: FLOOR_MS });
    if (plan.drop.length === 0 && plan.ranges.length === 0) continue;

    db.transaction(() => {
      for (const v of plan.drop) {
        db.prepare(
          "DELETE FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
        ).run(vaultId, path_hash, v);
      }
      for (const r of plan.ranges) {
        db.prepare(
          "UPDATE file_versions SET compacted_range = ? WHERE vault_id = ? AND path_hash = ? AND version = ?",
        ).run(r.label, vaultId, path_hash, r.version);
      }
    })();
    dropped += plan.drop.length;
  }

  // Purge before GC so expired trash no longer retains its chunks.
  const purged = purgeExpiredTrash(db, TRASH_RETENTION_DAYS * 24 * 3600, vaultId);

  // One cross-path GC pass over the surviving rows of the vault.
  const retained = new Set<string>();
  const chunkRows = db.prepare(
    "SELECT chunk_hashes FROM file_versions WHERE vault_id = ?",
  ).all(vaultId) as Array<{ chunk_hashes: string }>;
  for (const row of chunkRows) {
    for (const hash of JSON.parse(row.chunk_hashes) as string[]) retained.add(hash);
  }
  for (const hash of getTrashedChunkHashes(db, vaultId)) retained.add(hash);
  const gc = await gcUnreferencedBlobs(dataDir, vaultId, retained, Date.now(), GC_GRACE_MS);
  // #679: the pass dropped rows and blobs, so the counter is re-counted rather than
  // patched, which also corrects any drift a row deletion left behind.
  measureVault(db, dataDir, vaultId);

  log.info("compaction run", { vault_id: vaultId, dropped, purged, gc });
  return { dropped, gc };
}
