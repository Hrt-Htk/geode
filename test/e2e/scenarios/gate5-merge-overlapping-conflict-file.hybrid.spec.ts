import { expect, test } from "@playwright/test";
import type { SyncDevice } from "../helpers/device-abstraction";
import { launchHybridPair } from "../fixtures/hybrid-pair";
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

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`gate5 overlapping merge keeps the server winner canonical and writes a sibling conflict file (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

    try {
      await Promise.all([
        waitForUnlocked(pair.A),
        waitForUnlocked(pair.B),
        waitForStatusBar(pair.A, "Geode: synced", 60_000),
        waitForStatusBar(pair.B, "Geode: synced", 60_000),
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
        .poll(async () =>
          await pair.B.eval<string>("app.plugins.plugins.geode.getTransportState()")
        )
        .toBe("disconnected");

      await upsertVaultFile(pair.A, FILE_PATH, A_CONTENT);
      const aVersionBefore = await getLocalVersion(pair.A, FILE_PATH);
      await commitPath(pair.A, FILE_PATH);
      await expect
        .poll(async () => await getLocalVersion(pair.A, FILE_PATH), { timeout: 60_000 })
        .toBeGreaterThan(aVersionBefore);

      await writeVaultFileDirect(pair.B, FILE_PATH, B_CONTENT);
      await markLocalEdit(pair.B, FILE_PATH);
      await expect.poll(async () => await pair.B.readVaultFile(FILE_PATH)).toBe(B_CONTENT);
      await queueCommitPath(pair.B, FILE_PATH);

      await reconnectSync(pair.B);
      await expect
        .poll(async () => await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"), {
          timeout: 60_000,
        })
        .toBeGreaterThan(baseSeq);

      await expect.poll(async () => await pair.B.readVaultFile(FILE_PATH), {
        timeout: 60_000,
      })
        .toBe(A_CONTENT);
      await expect.poll(async () => await pair.A.readVaultFile(FILE_PATH), {
        timeout: 60_000,
      })
        .toBe(A_CONTENT);

      await expect
        .poll(async () => (await listSiblingConflicts(pair.B, FILE_PATH)).length, {
          timeout: 60_000,
        })
        .toBe(1);

      const [relativeConflictPath] = await listSiblingConflicts(pair.B, FILE_PATH);
      expect(relativeConflictPath).toBeDefined();
      expect(relativeConflictPath.startsWith("notes/merge (conflict ")).toBe(true);

      const canonical = await pair.B.readVaultFile(FILE_PATH);
      expect(canonical).toBe(A_CONTENT);
      expect(canonical).not.toContain("<<<<<<<");
      expect(canonical).not.toContain("=======");
      expect(canonical).not.toContain(">>>>>>>");

      const conflictContent = await pair.B.readVaultFile(relativeConflictPath);
      expect(conflictContent).toBe(B_CONTENT);
    } finally {
      await pair.stop();
    }
  });
}

async function listSiblingConflicts(device: SyncDevice, vaultPath: string): Promise<string[]> {
  const parts = vaultPath.split("/");
  const fileName = parts.pop()!;
  const dir = parts.join("/");
  const stem = fileName.replace(/\.[^.]+$/, "");
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot) : "";
  const entries = await device.listVaultDir(dir);
  return entries
    .filter((e) => e.startsWith(`${stem} (conflict `) && e.endsWith(ext))
    .map((e) => (dir ? `${dir}/${e}` : e));
}
