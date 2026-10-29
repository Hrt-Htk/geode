// #493: shared helpers for interrupt/recovery E2E: deterministic kill signals from the
// server DB (poll version counts, never flush timing), desktop hard-kill + relaunch on the
// same dirs, and server-side chunk-hash verification of committed content.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import type { Evaluatable } from "./device-abstraction";

const execFileAsync = promisify(execFile);
const DENO_BIN = process.env.DENO_BIN ?? "deno";

function openServerDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
}

/** Total file_versions rows for the vault: one row per commit; a duplicate-upload storm shows up here. */
export function serverVersionCount(dataDir: string, vaultId: string): number {
  const db = openServerDb(dataDir);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?").get(
      vaultId,
    ) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Highest global seq committed for the vault (the cursor a fully-caught-up device must reach). */
export function serverMaxSeq(dataDir: string, vaultId: string): number {
  const db = openServerDb(dataDir);
  try {
    const row = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS s FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { s: number };
    return row.s;
  } finally {
    db.close();
  }
}

/** chunk_hashes (plaintext hex, one JSON array per row) for every version of the vault. */
export function serverChunkHashSets(dataDir: string, vaultId: string): string[][] {
  const db = openServerDb(dataDir);
  try {
    const rows = db.prepare("SELECT chunk_hashes FROM file_versions WHERE vault_id = ?").all(
      vaultId,
    ) as { chunk_hashes: string }[];
    return rows.map((r) => JSON.parse(r.chunk_hashes) as string[]);
  } finally {
    db.close();
  }
}

/** Debug dump of every version row (version, parent, seq, created_at) for the vault. */
export function serverVersionsDump(dataDir: string, vaultId: string): string {
  const db = openServerDb(dataDir);
  try {
    const rows = db
      .prepare(
        "SELECT version, parent, seq, created_at FROM file_versions WHERE vault_id = ? ORDER BY seq",
      )
      .all(vaultId) as {
        version: number;
        parent: number | null;
        seq: number;
        created_at: number;
      }[];
    return rows.map((r) => `${r.version} (parent ${r.parent}, seq ${r.seq}, t=${r.created_at})`)
      .join("\n");
  } finally {
    db.close();
  }
}

/** Total vaults on the server: a wizard create lands a new row before the local settings are saved. */
export function serverVaultCount(dataDir: string): number {
  const db = openServerDb(dataDir);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM vaults").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Active devices on the vault: real (non-restore-pseudo) and not soft-revoked. Revoke is a
 * soft-revoke (the row stays, the token becomes a `revoked:` sentinel), so this matches what the
 * server's device listings show (they filter `token NOT LIKE 'revoked:%'`). */
export function serverDeviceCount(dataDir: string, vaultId: string): number {
  const db = openServerDb(dataDir);
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE vault_id = ? AND is_restore = 0 AND token NOT LIKE 'revoked:%'",
      )
      .get(vaultId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** A device's name on the server (null when the row is gone). */
export function serverDeviceName(
  dataDir: string,
  vaultId: string,
  deviceId: string,
): string | null {
  const db = openServerDb(dataDir);
  try {
    const row = db
      .prepare("SELECT name FROM devices WHERE vault_id = ? AND id = ?")
      .get(vaultId, deviceId) as { name: string } | undefined;
    return row?.name ?? null;
  } finally {
    db.close();
  }
}

/** trashed_heads rows for the vault: restore/purge delete the row server-side. */
export function serverTrashCount(dataDir: string, vaultId: string): number {
  const db = openServerDb(dataDir);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?").get(
      vaultId,
    ) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Poll a probe until it satisfies `pred` (the deterministic kill signal for non-version server state). */
export async function waitForServerState<T>(
  probe: () => T,
  pred: (v: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const startedAt = Date.now();
  let last: T;
  for (;;) {
    last = probe();
    if (pred(last)) return last;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}; last: ${String(last)}`);
    }
    await sleep(250);
  }
}

/** Poll the server DB until the vault has at least `target` versions (the deterministic mid-operation kill signal). */
export async function waitForServerCount(
  dataDir: string,
  vaultId: string,
  target: number,
  timeoutMs: number,
  label = `server version count >= ${target}`,
): Promise<number> {
  const startedAt = Date.now();
  let last = 0;
  while (Date.now() - startedAt < timeoutMs) {
    last = serverVersionCount(dataDir, vaultId);
    if (last >= target) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}; last count: ${last}`);
}

/** SIGKILL the desktop app mid-operation, relaunch on the SAME vault + user-data dirs (state survives). */
export async function relaunchDesktop(inst: ObsidianInstance): Promise<ObsidianInstance> {
  await inst.hardKill();
  return await launchObsidian({
    vaultDir: inst.vaultDir,
    userDataDir: inst.userDataDir,
    prepared: true,
    geodeSettings: inst.settings,
    /* keepStartupModal: the fixture's dismissStartupModal presses Escape and would close
     * the setup wizard that auto-opens on an unconfigured relaunch. */
    keepStartupModal: true,
    keepVaultDir: true,
    keepUserDataDir: true,
  });
}

/** After a relaunch the key cache may or may not have auto-unlocked: accept either, unlock if locked. */
export async function unlockIfLocked(
  inst: Evaluatable,
  passphrase: string,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const unlocked = await inst.eval<boolean>(
      "Boolean(app.plugins?.plugins?.geode?.isUnlockedCheck?.())",
    );
    if (unlocked) return;
    if (Date.now() - startedAt > timeoutMs) {
      await inst.eval(`await app.plugins.plugins.geode.unlockVault(${JSON.stringify(passphrase)})`);
      return;
    }
    await sleep(500);
  }
}

type ChunkHashItem = { path: string; content: string };

/**
 * Server-side content proof: the expected per-chunk plaintext hashes for each file, computed with
 * the real core/ chunker (Deno, same code path as the plugin). Compare against serverChunkHashSets.
 */
export async function chunkHashesFor(items: ChunkHashItem[]): Promise<Record<string, string[]>> {
  const scriptPath = path.join(
    process.cwd(),
    "test",
    "e2e",
    "helpers",
    "compute-chunk-hashes.deno.ts",
  );
  // Items go through a temp file, not argv: a large batch exceeds the OS arg limit (E2BIG).
  const dir = await mkdtemp(path.join(tmpdir(), "geode-e2e-chunkhashes-"));
  try {
    const itemsPath = path.join(dir, "items.json");
    await writeFile(itemsPath, JSON.stringify(items));
    const { stdout, stderr } = await execFileAsync(DENO_BIN, ["run", "-A", scriptPath, itemsPath]);
    const result = stdout.trim();
    if (!result) throw new Error(`compute-chunk-hashes produced no output. stderr: ${stderr}`);
    return JSON.parse(result) as Record<string, string[]>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
