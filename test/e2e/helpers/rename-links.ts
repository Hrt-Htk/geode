// #587: oracles and fixtures shared by the hybrid rename matrix. The server only
// stores the flag, so a marker (deleted + rename_mark 1) closes the old path and a
// note (rename_mark 2) opens the new one. Rows are attributed to paths through each
// device's own tracked path hashes: no metadata decryption, no name leaks.
import { expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { type HybridPair, launchHybridPair } from "../fixtures/hybrid-pair";
import type { SyncDevice } from "./device-abstraction";
import { writeVaultFile } from "./editor";
import { commitPath, waitForUnlocked } from "./geode";
import { waitForConvergence, waitForStatusBar } from "./waits";

export type VersionRow = { version: number; deleted: number; rename_mark: number };
export type RenameLink = VersionRow & { path_hash: string };

export type ServerRef = { dataDir: string; vaultId: string };

function withDb<T>(server: ServerRef, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(server.dataDir, "geode.db"), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Every version row of the vault carrying a rename link, by seq. */
export function renameLinks(server: ServerRef): RenameLink[] {
  return withDb(
    server,
    (db) =>
      db
        .prepare(
          "SELECT path_hash, version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND rename_mark != 0 ORDER BY seq",
        )
        .all(server.vaultId) as RenameLink[],
  );
}

/** The versions of one path, oldest first (empty = the server holds no history for that name). */
export function serverChain(server: ServerRef, pathHash: string): VersionRow[] {
  return withDb(
    server,
    (db) =>
      db
        .prepare(
          "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
        )
        .all(server.vaultId, pathHash) as VersionRow[],
  );
}

/** The device's own tracked path hashes: the key the server stores every row under. */
export async function pathHashesOf(
  device: SyncDevice,
  vaultPaths: string[],
): Promise<string[]> {
  const hashes = await device.eval<Array<string | null>>(
    `${
      JSON.stringify(vaultPaths)
    }.map((p) => app.plugins.plugins.geode.state.getLocalFile(p)?.path_hash ?? null)`,
  );
  const missing = vaultPaths.filter((_, i) => hashes[i] === null);
  if (missing.length > 0) throw new Error(`no tracked row for ${missing.join(", ")}`);
  return hashes as string[];
}

/** Poll until the vault's rename links match `expected` by (version, deleted, mark), order-free. */
export async function expectRenameLinks(
  server: ServerRef,
  expected: VersionRow[],
  timeoutMs = 120_000,
): Promise<void> {
  const shape = (rows: VersionRow[]) =>
    rows.map(({ version, deleted, rename_mark }) => `${version}/${deleted}/${rename_mark}`).sort();
  await expect
    .poll(() => shape(renameLinks(server)), { timeout: timeoutMs })
    .toEqual(shape(expected));
}

/** A hybrid pair, unlocked and caught up on both devices. */
export async function launchSyncedPair(
  passphrase: string,
  phoneAsA: boolean,
): Promise<HybridPair> {
  const pair = await launchHybridPair({ passphrase, phoneAsA });
  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B, "Geode: synced", 60_000);
    return pair;
  } catch (error) {
    await pair.stop();
    throw error;
  }
}

/** Write `content` at `vaultPath` on `A`, commit it, and wait until `B` holds the same bytes. */
export async function seedNote(
  A: SyncDevice,
  B: SyncDevice,
  vaultPath: string,
  content: string,
): Promise<void> {
  await writeVaultFile(A, vaultPath, content);
  await commitPath(A, vaultPath);
  await waitForConvergence(A, B, vaultPath, 60_000);
}

/** Rename through the real vault API, so the plugin's own rename event writes the link. */
export async function renameInVault(
  device: SyncDevice,
  from: string,
  to: string,
): Promise<void> {
  await device.eval(`
    const entry = app.vault.getAbstractFileByPath(${JSON.stringify(from)});
    if (!entry) throw new Error("expected the entry to rename: " + ${JSON.stringify(from)});
    await app.vault.rename(entry, ${JSON.stringify(to)});
    return true;
  `);
}

/** File names inside `dir`; empty when the folder is gone (a moved-away folder is not synced). */
export async function folderFiles(device: SyncDevice, dir: string): Promise<string[]> {
  return await device.eval<string[]>(`
    (await app.vault.adapter.exists(${JSON.stringify(dir)}))
      ? (await app.vault.adapter.list(${JSON.stringify(dir)})).files.map((f) => f.split("/").pop())
      : []
  `);
}

/** Text of `vaultPath` plus any sibling conflict file: an edit survives in one of them. */
export async function textWithConflicts(
  device: SyncDevice,
  vaultPath: string,
): Promise<string> {
  const dir = vaultPath.split("/").slice(0, -1).join("/");
  const name = vaultPath.split("/").pop()!;
  const stem = name.replace(/\.[^.]+$/, "");
  const siblings = (await folderFiles(device, dir)).filter((f) =>
    f.startsWith(`${stem} (conflict `)
  );
  const paths = [name, ...siblings].map((f) => (dir ? `${dir}/${f}` : f));
  const texts: string[] = [];
  for (const p of paths) {
    texts.push((await device.fileExists(p)) ? await device.readVaultFile(p) : "");
  }
  return texts.join("\n");
}

/** Reveal `vaultPath` in the file explorer (mobile: expand the left drawer) for the screenshot. */
export async function showInExplorer(
  device: SyncDevice,
  vaultPath: string,
): Promise<void> {
  await device.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(vaultPath)});
    if (!file) throw new Error("expected the file to reveal: " + ${JSON.stringify(vaultPath)});
    await app.workspace.getLeaf(true).openFile(file);
    await app.commands.executeCommandById("file-explorer:reveal-active-file");
    if (document.body.classList.contains("is-mobile")) app.workspace.leftSplit.expand();
    return true;
  `);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
