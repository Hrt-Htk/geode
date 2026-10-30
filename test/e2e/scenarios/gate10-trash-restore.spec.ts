import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { commitPath, revealFileInExplorer, upsertVaultFile } from "../helpers/geode";
import { waitForConvergence, waitForFileInExplorer, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate10-restore-pass";
const FILE_PATH = "notes/restore-me.md";
const CONTENT = "# Restore me\nThis file should survive a delete+restore cycle.\n";

type TrashEntry = {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
};

test(
  "gate10 trash restore: deleted file reappears on both instances after programmatic restore",
  async () => {
    test.slow();

    const pair = await launchPair({ passphrase: PASSPHRASE });

    try {
      // 1. Both instances unlocked and synced.
      await expect
        .poll(
          async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
      await expect
        .poll(
          async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
      await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
      await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

      // 2. A creates notes/restore-me.md with known content and commits.
      await upsertVaultFile(pair.A, FILE_PATH, CONTENT);
      await commitPath(pair.A, FILE_PATH, "commit");

      const syncedCreate = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
      expect(syncedCreate).toBe(CONTENT);

      // 3. A deletes the file and commits the deletion.
      await pair.A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) {
        throw new Error("expected file to delete: " + path);
      }
      await app.vault.delete(file);
      return !(await app.vault.adapter.exists(path));
    `);
      await commitPath(pair.A, FILE_PATH, "delete");

      // Both instances should converge to the file being absent.
      expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBeNull();

      // 4. Verify the file appears in trash on A.
      const trash = await pair.A.eval<TrashEntry[]>(
        "await app.plugins.plugins.geode.trash.list()",
      );
      expect(trash.length).toBe(1);
      const pathHash = trash[0].path_hash;
      expect(typeof pathHash).toBe("string");
      expect(pathHash.length).toBeGreaterThan(0);

      // 5. Restore the file via the programmatic API.
      await pair.A.eval(
        `await app.plugins.plugins.geode.trash.restore(${JSON.stringify(pathHash)})`,
      );

      // 6. File should converge back to its original content on BOTH A and B.
      expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBe(CONTENT);

      // 7. The restored file shows in the real file-explorer DOM on both instances.
      for (const inst of [pair.A, pair.B]) {
        await revealFileInExplorer(inst, FILE_PATH);
        await waitForFileInExplorer(inst.win, FILE_PATH, 60_000);
      }

      // 8. Trash should now be empty.
      const trashAfter = await pair.A.eval<TrashEntry[]>(
        "await app.plugins.plugins.geode.trash.list()",
      );
      expect(trashAfter.length).toBe(0);

      // 9. No console errors on either instance.
      expect(pair.A.consoleErrors()).toEqual([]);
      expect(pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  },
);
