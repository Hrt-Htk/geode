// Shared harness for the benchmark and soak gates: real-vault seeding, two-vault
// quiescence, and on-disk comparison. NOT a *.test.ts: needs a real-vault copy.
// Reads the source vault READ-ONLY; never a write call against it.
import { arraysEqual } from "../helpers/bytes.ts";
import { hashPathHex } from "../../core/hash.ts";
import type { TestPlugin, TestServer } from "../two-vault-driver.ts";

export type BenchDb = TestServer["db"];
export type BenchFile = { path: string; data: Uint8Array };

/** Recursively read a directory into memory (source vault stays untouched). */
export function walkFiles(dir: string, prefix = ""): BenchFile[] {
  const out: BenchFile[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...walkFiles(full, rel));
    } else if (entry.isFile && !rel.startsWith(".obsidian/plugins/geode/")) {
      // Skip the geode plugin junction (a link to plugin-dist).
      out.push({ path: rel, data: Deno.readFileSync(full) });
    }
  }
  return out;
}

/** Deterministic size-spread sample of `k` binaries, so a run is reproducible. */
export function sampleBinaries(files: BenchFile[], k: number): BenchFile[] {
  const sorted = [...files].sort((a, b) => a.data.length - b.data.length);
  if (sorted.length <= k) return sorted;
  const step = sorted.length / k;
  return Array.from({ length: k }, (_, i) => sorted[Math.floor(i * step)]);
}

export function withoutConfig(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].filter(([path]) => !path.startsWith(".obsidian/")));
}

export function configCount(files: Map<string, Uint8Array>): number {
  return [...files.keys()].filter((path) => path.startsWith(".obsidian/")).length;
}

/** Version rows held for `.obsidian/` paths: a storm would churn them. */
export function configVersions(
  db: BenchDb,
  vaultId: string,
  keys: NonNullable<TestPlugin["keys"]>,
  paths: string[],
): number {
  const rows = db.prepare(
    "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
  );
  return paths.reduce(
    (n, path) => n + (rows.get(vaultId, hashPathHex(keys.mac_key, path)) as { n: number }).n,
    0,
  );
}

export function mapsEqual(
  a: Map<string, Uint8Array>,
  b: Map<string, Uint8Array>,
): { equal: boolean; diff: string[] } {
  const diff: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(key)) diff.push(`missing in A: ${key}`);
    else if (!b.has(key)) diff.push(`missing in B: ${key}`);
    else if (!arraysEqual(a.get(key)!, b.get(key)!)) diff.push(`content mismatch: ${key}`);
  }
  return { equal: diff.length === 0, diff };
}

/** Path hashes currently in the server's trash (one row per deleted name). */
export function trashedHashes(db: BenchDb, vaultId: string): Set<string> {
  const rows = db.prepare("SELECT path_hash FROM trashed_heads WHERE vault_id = ?")
    .all(vaultId) as Array<{ path_hash: string }>;
  return new Set(rows.map((r) => r.path_hash));
}

export function versionCount(db: BenchDb, vaultId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
  ).get(vaultId) as { n: number };
  return row.n;
}

export function maxSeq(db: BenchDb, vaultId: string): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS s FROM file_versions WHERE vault_id = ?",
  ).get(vaultId) as { s: number };
  return row.s;
}

/** Flush events, reconcile, and drain the commit queue with a generous timeout
 * (a seed push has hundreds of files at once; the default 10 s idle wait is too short). */
export async function pushAndDrain(dev: TestPlugin, timeoutMs = 120_000): Promise<void> {
  dev.eventHandler.flushNow();
  await dev.syncManager.reconcileNow();
  await dev.waitForIdle(timeoutMs);
}

/** Settle to quiescence: a stable server count is not enough: devices must have
 * caught up (applied) before comparing. Returns false if the count keeps growing.
 * Takes a device list so a paused/offline device is not waited on. */
export async function settle(
  devices: TestPlugin[],
  db: BenchDb,
  vaultId: string,
  maxRounds = 15,
): Promise<boolean> {
  let prev = -1;
  for (let round = 0; round < maxRounds; round++) {
    for (const dev of devices) await dev.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    const count = versionCount(db, vaultId);
    if (count === prev) {
      const s = await maxSeq(db, vaultId);
      for (const dev of devices) await dev.waitForCaughtUp(s);
      return versionCount(db, vaultId) === count;
    }
    prev = count;
  }
  throw new Error(
    `settle: no convergence after ${maxRounds} rounds (versions=${versionCount(db, vaultId)})`,
  );
}
