import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #98: hybrid: the trash panel lists the deleted file and restores it.

const PASSPHRASE = "ui-pass";
const FILE_PATH = "notes/restore-via-ui.md";
const CONTENT = "# UI restore\nThis file is restored through the dedicated Trash modal.\n";

type TrashEntry = {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
};

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(
    `trash UI: deleted file visible in the trash modal and restores via Restore button (${role})`,
    async () => {
      test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
      test.slow();

      const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

      try {
        // 1. Both devices unlocked and synced.
        await expect
          .poll(
            async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
            { timeout: 60_000 },
          )
          .toBe(true);
        await expect
          .poll(
            async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
            { timeout: 60_000 },
          )
          .toBe(true);
        await waitForStatusBar(pair.A, "Geode: synced", 60_000);
        await waitForStatusBar(pair.B, "Geode: synced", 60_000);

        // 2. A creates the file and commits.
        await upsertVaultFile(pair.A, FILE_PATH, CONTENT);
        await commitPath(pair.A, FILE_PATH, "commit");

        const syncedCreate = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
        expect(syncedCreate).toBe(CONTENT);

        // 3. A deletes the file and commits the deletion; both converge to absent.
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

        expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBeNull();

        // 4. Get pathHash from the DESKTOP's trash list (trash entry may arrive async).
        const desktop = pair.A.vaultDir !== null ? pair.A : pair.B;
        await expect
          .poll(
            async () =>
              (
                await desktop.eval<TrashEntry[]>(
                  "await app.plugins.plugins.geode.trash.list()",
                )
              ).length,
            { timeout: 60_000 },
          )
          .toBe(1);
        const trash = await desktop.eval<TrashEntry[]>(
          "await app.plugins.plugins.geode.trash.list()",
        );
        const pathHash = trash[0].path_hash;
        const restoreSel = `[data-testid="geode-trash-restore"][data-path-hash="${pathHash}"]`;

        // 5. Open the TrashModal on the desktop (trash is a modal, not a side panel).
        await desktop.eval(`
      app.plugins.plugins.geode.openTrashModal();
      return "ok";
    `);

        // 6. Poll until the modal is present.
        await expect
          .poll(
            async () =>
              await desktop.eval<boolean>(
                `!!document.querySelector('.geode-trash-modal')`,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);

        // Wait for the per-row restore button whose data-path-hash matches our deleted file.
        await expect
          .poll(
            async () =>
              await desktop.eval<boolean>(
                `!!document.querySelector(${JSON.stringify(restoreSel)})`,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);

        // 7. Click the per-row Restore button via eval.
        await desktop.eval(
          `document.querySelector(${JSON.stringify(restoreSel)}).click(); return true;`,
        );

        // 8. Wait for the file to reappear on desktop first (restore is async: POST → WS → apply).
        await expect
          .poll(
            async () => await desktop.fileExists(FILE_PATH),
            { timeout: 60_000 },
          )
          .toBe(true);

        // 9. File should converge back to original content on both A and B.
        expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBe(CONTENT);

        // 10. After the modal re-renders, the restore row should be gone or empty-state visible.
        await expect
          .poll(
            async () =>
              await desktop.eval<boolean>(
                `document.querySelectorAll('[data-testid="geode-trash-restore"]').length === 0 || !!document.querySelector('[data-testid="geode-trash-empty"]')`,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);

        // 11. No console errors on either instance.
        expect(await pair.A.consoleErrors()).toEqual([]);
        expect(await pair.B.consoleErrors()).toEqual([]);
      } finally {
        await pair.stop();
      }
    },
  );
}
