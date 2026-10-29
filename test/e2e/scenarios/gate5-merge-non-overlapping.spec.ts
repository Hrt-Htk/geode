import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { launchPair } from "../fixtures/pair";
import {
  commitPath,
  disconnectSync,
  getLocalVersion,
  markLocalEdit,
  reconnectSync,
  upsertVaultFile,
  waitForUnlocked,
  writeVaultFileDirect,
} from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate5-merge-passphrase";
const FILE_PATH = "notes/merge.md";
const BASE_CONTENT = "line 1\nline 2\nline 3\nline 4\nline 5";
const A_CONTENT = "A edited line 1\nline 2\nline 3\nline 4\nline 5";
const B_CONTENT = "line 1\nline 2\nline 3\nline 4\nB edited line 5";

test("gate5 merge non-overlapping cleanly merges concurrent markdown edits in real Obsidian", async () => {
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
    await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);

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
    await reconnectSync(pair.B);
    await expect
      .poll(async () => await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"), {
        timeout: 60_000,
      })
      .toBeGreaterThan(baseSeq);
    await expect.poll(async () => await readVaultDisk(pair.B.vaultDir, FILE_PATH), {
      timeout: 60_000,
    })
      .toContain("A edited line 1");
    await expect.poll(async () => await readVaultDisk(pair.B.vaultDir, FILE_PATH), {
      timeout: 60_000,
    })
      .toContain("B edited line 5");
    await commitPath(pair.B, FILE_PATH);

    const convergedContent = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
    await expect.poll(async () => {
      const [aDisk, bDisk] = await Promise.all([
        readVaultDisk(pair.A.vaultDir, FILE_PATH),
        readVaultDisk(pair.B.vaultDir, FILE_PATH),
      ]);
      return aDisk === bDisk;
    }, { timeout: 60_000 }).toBe(true);
    const bContent = await readVaultDisk(pair.B.vaultDir, FILE_PATH);
    const aContent = await readVaultDisk(pair.A.vaultDir, FILE_PATH);

    expect(convergedContent).not.toBeNull();
    expect(aContent).toBe(bContent);
    expect(aContent).toContain("A edited line 1");
    expect(aContent).toContain("B edited line 5");

    expect(await listSiblingConflicts(pair.A.vaultDir, FILE_PATH)).toEqual([]);
    expect(await listSiblingConflicts(pair.B.vaultDir, FILE_PATH)).toEqual([]);
    expect(aContent).not.toContain("<<<<<<<");
    expect(aContent).not.toContain("=======");
    expect(aContent).not.toContain(">>>>>>>");
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
  return entries.filter((entry) => entry.startsWith(`${stem} (conflict `) && entry.endsWith(ext));
}
