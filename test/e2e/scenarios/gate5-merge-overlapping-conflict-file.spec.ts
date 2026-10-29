import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isConflictPath } from "../../../plugin/sync/conflicts";
import { launchPair } from "../fixtures/pair";
import {
  commitPath,
  disconnectSync,
  getLocalVersion,
  markLocalEdit,
  queueCommitPath,
  reconnectSync,
  upsertVaultFile,
  waitForUnlocked,
  writeVaultFileDirect,
} from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate5-merge-passphrase";
const FILE_PATH = "notes/merge.md";
const BASE_CONTENT = "line 1\nline 2\nline 3";
const A_CONTENT = "line 1\nA edited line 2\nline 3";
const B_CONTENT = "line 1\nB edited line 2\nline 3";

test("gate5 overlapping merge keeps the server winner canonical and writes a sibling conflict file", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await Promise.all([
      waitForUnlocked(pair.A),
      waitForUnlocked(pair.B),
      waitForStatusBar(pair.A.win, "Geode: synced", 60_000),
      waitForStatusBar(pair.B.win, "Geode: synced", 60_000),
    ]);

    await upsertVaultFile(pair.A, FILE_PATH, BASE_CONTENT);
    await commitPath(pair.A, FILE_PATH);
    await expect
      .poll(async () => await getLocalVersion(pair.A, FILE_PATH), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"), {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    const baseSeq = await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()");
    await disconnectSync(pair.B);
    await expect
      .poll(async () => await pair.B.eval<string>("app.plugins.plugins.geode.getTransportState()"))
      .toBe("disconnected");

    await upsertVaultFile(pair.A, FILE_PATH, A_CONTENT);
    const aVersionBefore = await getLocalVersion(pair.A, FILE_PATH);
    await commitPath(pair.A, FILE_PATH);
    await expect
      .poll(async () => await getLocalVersion(pair.A, FILE_PATH), { timeout: 60_000 })
      .toBeGreaterThan(aVersionBefore);

    await writeVaultFileDirect(pair.B, FILE_PATH, B_CONTENT);
    await markLocalEdit(pair.B, FILE_PATH);
    await expect.poll(async () => await readVaultDisk(pair.B.vaultDir, FILE_PATH)).toBe(B_CONTENT);
    await queueCommitPath(pair.B, FILE_PATH);

    await reconnectSync(pair.B);
    await expect
      .poll(async () => await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"), {
        timeout: 60_000,
      })
      .toBeGreaterThan(baseSeq);

    await expect.poll(async () => await readVaultDisk(pair.B.vaultDir, FILE_PATH), {
      timeout: 60_000,
    })
      .toBe(A_CONTENT);
    await expect.poll(async () => await readVaultDisk(pair.A.vaultDir, FILE_PATH), {
      timeout: 60_000,
    })
      .toBe(A_CONTENT);

    await expect
      .poll(async () => (await listSiblingConflicts(pair.B.vaultDir, FILE_PATH)).length, {
        timeout: 60_000,
      })
      .toBe(1);

    const [relativeConflictPath] = await listSiblingConflicts(pair.B.vaultDir, FILE_PATH);
    expect(relativeConflictPath).toBeDefined();
    expect(relativeConflictPath.startsWith("notes/merge (conflict ")).toBe(true);
    expect(isConflictPath(relativeConflictPath)).toBe(true);

    const canonical = await readVaultDisk(pair.B.vaultDir, FILE_PATH);
    expect(canonical).toBe(A_CONTENT);
    expect(canonical).not.toContain("<<<<<<<");
    expect(canonical).not.toContain("=======");
    expect(canonical).not.toContain(">>>>>>>");

    const conflictContent = await readVaultDisk(pair.B.vaultDir, relativeConflictPath);
    expect(conflictContent).toBe(B_CONTENT);
  } finally {
    await pair.stop();
  }
});

async function readVaultDisk(vaultDir: string, vaultPath: string): Promise<string> {
  return await readFile(path.join(vaultDir, ...vaultPath.split("/")), "utf8");
}

async function listSiblingConflicts(vaultDir: string, vaultPath: string): Promise<string[]> {
  const parts = vaultPath.split("/");
  const fileName = parts.pop()!;
  const dirPath = path.join(vaultDir, ...parts);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const ext = path.extname(fileName);
  const entries = await readdir(dirPath).catch(() => []);
  return entries
    .filter((entry) => entry.startsWith(`${stem} (conflict `) && entry.endsWith(ext))
    .map((entry) => [...parts, entry].join("/"));
}
