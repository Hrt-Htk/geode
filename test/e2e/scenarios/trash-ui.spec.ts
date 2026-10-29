import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #98: the trash panel lists the deleted file by its decrypted name and restores it.

const PASSPHRASE = "ui-pass";
const FILE_PATH = "notes/restore-via-ui.md";
const CONTENT = "# UI restore\nThis file is restored through the dedicated Trash modal.\n";

type TrashEntry = {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
};

test("trash UI: deleted file is visible in the trash modal and restores via Restore button", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    // 1. Both instances unlocked and synced.
    await expect
      .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"), {
        timeout: 60_000,
      })
      .toBe(true);
    await expect
      .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"), {
        timeout: 60_000,
      })
      .toBe(true);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    // 2. A creates the file and commits.
    await upsertVaultFile(pair.A, FILE_PATH, CONTENT);
    await commitPath(pair.A, FILE_PATH, "commit");

    const syncedCreate = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
    expect(syncedCreate).toBe(CONTENT);

    // 3. A deletes the file and commits the deletion; both instances converge to absent.
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

    // Capture path_hash for later assertions.
    const trash = await pair.A.eval<TrashEntry[]>(
      "await app.plugins.plugins.geode.trash.list()",
    );
    expect(trash.length).toBe(1);
    const pathHash = trash[0].path_hash;

    // 4. Open the TrashModal via eval (trash is a modal, not a side panel).
    await pair.A.eval(`
      app.plugins.plugins.geode.openTrashModal();
      return "ok";
    `);

    // 5. Assert the modal is present and the trashed entry row is visible.
    //    The list loads asynchronously, so poll.
    await expect
      .poll(
        async () =>
          await pair.A.win
            .locator(".geode-trash-modal")
            .isVisible()
            .catch(() => false),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The purge-expired confirm reads the loaded trash list for its count, so the button
    // stays disabled until trash.list() resolves; once the list renders it must be enabled.
    await expect(
      pair.A.win.locator('[data-testid="geode-trash-purge-expired"]'),
    ).toBeEnabled({ timeout: 30_000 });

    // Wait for the per-row restore button whose data-path-hash matches our deleted file.
    const restoreRowLocator = pair.A.win.locator(
      `[data-testid="geode-trash-restore"][data-path-hash=${JSON.stringify(pathHash)}]`,
    );
    await expect
      .poll(
        async () => {
          // The list renders asynchronously: keep checking until the row appears.
          return await restoreRowLocator.isVisible().catch(() => false);
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // 6. Click the per-row Restore button in the modal.
    await restoreRowLocator.click();

    // 7. The file should converge back to original content on both A and B.
    expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBe(CONTENT);

    // 8. After the modal re-renders, the row should be gone (trash empty indicator or zero rows).
    await expect
      .poll(
        async () => {
          const rowCount = await pair.A.win
            .locator('[data-testid="geode-trash-restore"]')
            .count();
          const emptyVisible = await pair.A.win
            .locator('[data-testid="geode-trash-empty"]')
            .isVisible()
            .catch(() => false);
          return rowCount === 0 || emptyVisible;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // 9. No console errors on either instance.
    expect(pair.A.consoleErrors()).toEqual([]);
    expect(pair.B.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
