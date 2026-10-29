import { expect, test } from "@playwright/test";
import { serverTrashCount } from "../helpers/interrupt";
import {
  expectRenameLinks,
  folderFiles,
  launchSyncedPair,
  pathHashesOf,
  renameInVault,
  renameLinks,
  seedNote,
  serverChain,
  showInExplorer,
} from "../helpers/rename-links";

// #587 item 3: a real rename on one device must reach the other as a MOVE: it ends
// with only the new name, and the server holds one marker closing the old path and
// one note opening the new one, with no trash entry (a marker is never a deletion).
const PASSPHRASE = "rename-note";
const OLD = "notes/rename-me.md";
const NEW = "notes/renamed-note.md";
const CONTENT = "# rename me\nhistory follows the note\n";

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`rename: the other device keeps only the new name (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      const trashBefore = serverTrashCount(pair.server.dataDir, pair.server.vaultId);
      await seedNote(pair.A, pair.B, OLD, CONTENT);
      const [oldHash] = await pathHashesOf(pair.A, [OLD]);

      await renameInVault(pair.A, OLD, NEW);

      await expectRenameLinks(pair.server, [
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);
      const [newHash] = await pathHashesOf(pair.A, [NEW]);
      expect(renameLinks(pair.server).map((link) => link.path_hash)).toEqual([oldHash, newHash]);
      expect(serverChain(pair.server, oldHash)).toEqual([
        { version: 1, deleted: 0, rename_mark: 0 },
        { version: 2, deleted: 1, rename_mark: 1 },
      ]);
      expect(serverChain(pair.server, newHash)).toEqual([
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

      for (const device of [pair.A, pair.B]) {
        await expect.poll(() => device.fileExists(OLD), { timeout: 120_000 }).toBe(false);
        expect(await device.fileExists(NEW)).toBe(true);
        expect(await device.readVaultFile(NEW)).toBe(CONTENT);
        expect(await folderFiles(device, "notes")).toEqual(["renamed-note.md"]);
      }
      expect(serverTrashCount(pair.server.dataDir, pair.server.vaultId)).toBe(trashBefore);

      await showInExplorer(pair.A, NEW);
      await pair.A.screenshot("587-rename-note-A.png");
      await showInExplorer(pair.B, NEW);
      await pair.B.screenshot("587-rename-note-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
