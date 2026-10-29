import { expect, test } from "@playwright/test";
import { commitPath, disconnectSync, reconnectSync, upsertVaultFile } from "../helpers/geode";
import {
  expectRenameLinks,
  launchSyncedPair,
  pathHashesOf,
  renameInVault,
  seedNote,
  serverChain,
  showInExplorer,
  textWithConflicts,
} from "../helpers/rename-links";

// #587 item 3: the other device edits the old name while offline, and the rename
// races it in both orders. Either way the edit survives (merged at the new name or
// kept in a conflict file) and the renamed-away name never comes back.
const PASSPHRASE = "rename-vs-edit";
const OLD = "notes/race.md";
const NEW = "notes/race-renamed.md";
const BASE = "# race\none\ntwo\nthree\n";
const OFFLINE_EDIT = "# race\none\nEDITED-WHILE-OFFLINE\ntwo\nthree\n";

type Pair = Awaited<ReturnType<typeof launchSyncedPair>>;

async function expectNameGone(pair: Pair): Promise<void> {
  for (const device of [pair.A, pair.B]) {
    await expect.poll(() => device.fileExists(OLD), { timeout: 120_000 }).toBe(false);
  }
}

/** The offline edit is on both devices: at the new name or in its conflict sibling. */
async function expectEditSurvives(pair: Pair): Promise<void> {
  for (const device of [pair.A, pair.B]) {
    await expect
      .poll(async () => (await textWithConflicts(device, NEW)).includes("EDITED-WHILE-OFFLINE"), {
        timeout: 120_000,
      })
      .toBe(true);
  }
}

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";

  test(`rename while the other device edits offline: rename reaches the server first (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      await seedNote(pair.A, pair.B, OLD, BASE);

      // The other device goes offline and edits the old name.
      await pair.B.eval(`app.plugins.plugins.geode.syncManager.pause(); return true;`);
      await upsertVaultFile(pair.B, OLD, OFFLINE_EDIT);
      await commitPath(pair.B, OLD);

      // The rename lands on the server first.
      await renameInVault(pair.A, OLD, NEW);
      await expectRenameLinks(pair.server, [
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

      await pair.B.eval(`await app.plugins.plugins.geode.syncManager.resume(); return true;`);

      await expectEditSurvives(pair);
      await expectNameGone(pair);
      expect(await pair.A.readVaultFile(NEW)).toContain("three");

      await showInExplorer(pair.A, NEW);
      await pair.A.screenshot("587-rename-vs-edit-rename-first-A.png");
      await showInExplorer(pair.B, NEW);
      await pair.B.screenshot("587-rename-vs-edit-rename-first-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });

  test(`rename while the other device edits offline: edit reaches the server first (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      await seedNote(pair.A, pair.B, OLD, BASE);
      const [oldHash] = await pathHashesOf(pair.A, [OLD]);

      // The renaming device drops off and misses the other device's edit.
      await disconnectSync(pair.A);
      await upsertVaultFile(pair.B, OLD, OFFLINE_EDIT);
      await commitPath(pair.B, OLD);
      await expect
        .poll(() => serverChain(pair.server, oldHash).length, { timeout: 60_000 })
        .toBe(2);

      // It renames blind, then reconnects: the marker closes an old name that advanced.
      await renameInVault(pair.A, OLD, NEW);
      await reconnectSync(pair.A);

      await expect
        .poll(() => serverChain(pair.server, oldHash).at(-1), { timeout: 120_000 })
        .toMatchObject({ deleted: 1, rename_mark: 1 });
      expect(serverChain(pair.server, oldHash)).toContainEqual({
        version: 2,
        deleted: 0,
        rename_mark: 0,
      });

      await expectEditSurvives(pair);
      await expectNameGone(pair);

      await showInExplorer(pair.A, NEW);
      await pair.A.screenshot("587-rename-vs-edit-edit-first-A.png");
      await showInExplorer(pair.B, NEW);
      await pair.B.screenshot("587-rename-vs-edit-edit-first-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
