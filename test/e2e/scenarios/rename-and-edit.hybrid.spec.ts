import { expect, test } from "@playwright/test";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import {
  expectRenameLinks,
  launchSyncedPair,
  renameInVault,
  seedNote,
  showInExplorer,
  textWithConflicts,
} from "../helpers/rename-links";

// #587 item 3: one device renames AND edits its copy while the other device is
// offline with its own edit of the old name. Both edits must survive (merged at the
// new name or kept in a conflict file) and the old name must be gone everywhere.
const PASSPHRASE = "rename-and-edit";
const OLD = "notes/both.md";
const NEW = "notes/both-renamed.md";
const BASE = "# both\none\ntwo\nthree\n";
const RENAMER_EDIT = "# both\none A-EDIT\ntwo\nthree\n";
const OFFLINE_EDIT = "# both\none\ntwo\nthree B-OFFLINE\n";

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`rename + edit keeps the offline device's edit too (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      await seedNote(pair.A, pair.B, OLD, BASE);

      await pair.B.eval(`app.plugins.plugins.geode.syncManager.pause(); return true;`);
      await upsertVaultFile(pair.B, OLD, OFFLINE_EDIT);
      await commitPath(pair.B, OLD);

      await upsertVaultFile(pair.A, OLD, RENAMER_EDIT);
      await renameInVault(pair.A, OLD, NEW);
      await expectRenameLinks(pair.server, [
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

      await pair.B.eval(`await app.plugins.plugins.geode.syncManager.resume(); return true;`);

      for (const device of [pair.A, pair.B]) {
        await expect
          .poll(async () => (await textWithConflicts(device, NEW)).includes("B-OFFLINE"), {
            timeout: 120_000,
          })
          .toBe(true);
        await expect
          .poll(async () => (await textWithConflicts(device, NEW)).includes("A-EDIT"), {
            timeout: 120_000,
          })
          .toBe(true);
        await expect.poll(() => device.fileExists(OLD), { timeout: 120_000 }).toBe(false);
      }

      await showInExplorer(pair.A, NEW);
      await pair.A.screenshot("587-rename-and-edit-A.png");
      await showInExplorer(pair.B, NEW);
      await pair.B.screenshot("587-rename-and-edit-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
