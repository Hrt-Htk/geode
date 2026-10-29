import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { readVaultFile } from "../helpers/editor";
import {
  waitForConvergence,
  waitForFileInExplorer,
  waitForFileMissingInExplorer,
  waitForStatusBar,
} from "../helpers/waits";

const PASSPHRASE = "gate4-shared-passphrase";
const FILE_PATH = "notes/a.md";
const INITIAL_CONTENT = "# A\nhello from A\n";
const UPDATED_CONTENT = "# A\nhello from A again\n";

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`gate4 basic sync propagates create modify and delete across two real Obsidian instances (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

    try {
      await expect
        .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await expect
        .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await waitForStatusBar(pair.A, "Geode: synced", 60_000);
      await waitForStatusBar(pair.B, "Geode: synced", 60_000);

      await pair.A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const content = ${JSON.stringify(INITIAL_CONTENT)};
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      if (await app.vault.adapter.exists(path)) {
        const existing = app.vault.getAbstractFileByPath(path);
        if (!existing) {
          throw new Error("expected existing file handle for " + path);
        }
        await app.vault.modify(existing, content);
      } else {
        await app.vault.create(path, content);
      }
      return await app.vault.adapter.read(path);
    `);

      await pair.A.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(FILE_PATH)}, kind: "commit" },
      ]);
      return true;
    `);
      await expect
        .poll(
          async () =>
            await pair.A.eval<number>(
              `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
                JSON.stringify(FILE_PATH)
              })?.last_seen_version ?? 0`,
            ),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(async () => await pair.B.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"))
        .toBeGreaterThan(0);
      expect(await pair.B.consoleErrors()).toEqual([]);
      await expect
        .poll(
          async () =>
            await pair.B.eval<boolean>(
              `await app.vault.adapter.exists(${JSON.stringify(FILE_PATH)})`,
            ),
        )
        .toBe(true);
      const syncedCreate = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
      await pair.B.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(FILE_PATH)});
      if (!file) {
        throw new Error("expected synced file in vault index");
      }
      await app.workspace.getLeaf(true).openFile(file);
      await app.commands.executeCommandById("file-explorer:reveal-active-file");
      return true;
    `);
      await waitForFileInExplorer(pair.B, FILE_PATH, 60_000);
      expect(syncedCreate).toBe(INITIAL_CONTENT);
      await expect.poll(async () => await readVaultFile(pair.B, FILE_PATH)).toBe(INITIAL_CONTENT);

      await pair.A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const content = ${JSON.stringify(UPDATED_CONTENT)};
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) {
        throw new Error("expected file to modify: " + path);
      }
      await app.vault.modify(file, content);
      return await app.vault.adapter.read(path);
    `);

      await pair.A.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(FILE_PATH)}, kind: "commit" },
      ]);
      return true;
    `);

      const syncedModify = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
      expect(syncedModify).toBe(UPDATED_CONTENT);
      await expect.poll(async () => await readVaultFile(pair.B, FILE_PATH)).toBe(UPDATED_CONTENT);

      await pair.A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) {
        throw new Error("expected file to delete: " + path);
      }
      await app.vault.delete(file);
      return !(await app.vault.adapter.exists(path));
    `);

      await pair.A.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(FILE_PATH)}, kind: "delete" },
      ]);
      return true;
    `);

      await expect.poll(async () => {
        const [aExists, bExists] = await Promise.all([
          pair.A.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(FILE_PATH)})`),
          pair.B.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(FILE_PATH)})`),
        ]);
        return { aExists, bExists };
      }, { timeout: 60_000 }).toEqual({ aExists: false, bExists: false });
      await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
      await waitForFileMissingInExplorer(pair.B, FILE_PATH, 60_000);
    } finally {
      await pair.stop();
    }
  });
}
