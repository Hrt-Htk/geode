import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForContent, waitForConvergence, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "restore-sticks-pass";
const FILE_PATH = "notes/restore-sticks.md";
const CONTENT = "# Restore sticks\nThis file must stay restored once a device restores it.\n";

// The re-delete in #498 lands "a moment" after the restore: long after the
// immediate convergence check. Hold this long to catch a late delete version.
const STICK_WINDOW_MS = 10_000;

type TrashEntry = {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
};

test("restore sticks: a restored file is not re-deleted by the deleter", async () => {
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

    // 2. A creates the file and commits; both converge.
    await upsertVaultFile(pair.A, FILE_PATH, CONTENT);
    await commitPath(pair.A, FILE_PATH, "commit");
    expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBe(CONTENT);

    // 3. A deletes the file and commits the deletion; both converge to absent.
    await pair.A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) throw new Error("expected file to delete: " + path);
      await app.vault.delete(file);
      return !(await app.vault.adapter.exists(path));
    `);
    await commitPath(pair.A, FILE_PATH, "delete");
    expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBeNull();

    // 4. B restores the file via the plugin's restore entry point (the same
    //    call the trash panel's Restore button makes): the real server route.
    const trash = await pair.B.eval<TrashEntry[]>("await app.plugins.plugins.geode.trash.list()");
    expect(trash.length).toBe(1);
    await pair.B.eval(
      `await app.plugins.plugins.geode.trash.restore(${JSON.stringify(trash[0].path_hash)})`,
    );

    // 5. Both converge back to the original content.
    await waitForContent(pair.A, pair.B, FILE_PATH, CONTENT, 60_000);

    // 6. The restore must STICK: hold the re-delete window and assert the file
    //    is still present on both with the original content, and no new delete
    //    version was committed (a re-delete would re-populate the server trash).
    await new Promise((resolve) => setTimeout(resolve, STICK_WINDOW_MS));

    expect(
      await pair.A.eval<string | null>(
        `(await app.vault.adapter.exists(${
          JSON.stringify(FILE_PATH)
        })) ? await app.vault.adapter.read(${JSON.stringify(FILE_PATH)}) : null`,
      ),
    ).toBe(CONTENT);
    expect(
      await pair.B.eval<string | null>(
        `(await app.vault.adapter.exists(${
          JSON.stringify(FILE_PATH)
        })) ? await app.vault.adapter.read(${JSON.stringify(FILE_PATH)}) : null`,
      ),
    ).toBe(CONTENT);

    const trashAfter = await pair.A.eval<TrashEntry[]>(
      "await app.plugins.plugins.geode.trash.list()",
    );
    expect(
      trashAfter,
      "a new delete version appeared after the restore (trash re-populated)",
    ).toEqual([]);

    // 7. Both still synced, no console errors.
    await waitForStatusBar(pair.A.win, "Geode: synced", 30_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 30_000);
    expect(pair.A.consoleErrors()).toEqual([]);
    expect(pair.B.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
