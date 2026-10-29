import { expect, test } from "@playwright/test";
import { serverTrashCount } from "../helpers/interrupt";
import {
  expectRenameLinks,
  folderFiles,
  launchSyncedPair,
  pathHashesOf,
  renameInVault,
  seedNote,
  serverChain,
  showInExplorer,
} from "../helpers/rename-links";
import { waitForContent } from "../helpers/waits";

// #587 item 3: a case-only rename is a real rename (decision 7), originating on the
// real Android FS (phone-as-A) and on the desktop. Both devices must end with exactly
// one file, spelled the new way, and the server must hold the link.
const PASSPHRASE = "rename-case";
const OLD = "notes/case-test.md";
const MID = "notes/case-test-mid.md";
const NEW = "notes/Case-Test.md";
const CONTENT = "# case only\nsame note, new spelling\n";

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A (Android origin)" : "desktop-as-A (desktop origin)";
  test(`case-only rename keeps one file with the new spelling (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      const trashBefore = serverTrashCount(pair.server.dataDir, pair.server.vaultId);
      await seedNote(pair.A, pair.B, OLD, CONTENT);
      const [oldHash] = await pathHashesOf(pair.A, [OLD]);

      if (phoneAsA) {
        // Android's emulated storage is case-insensitive and Obsidian's own rename refuses a
        // case-only destination, so on-device the spelling change takes a temporary name,
        // exactly what a user has to do there. Both hops must still carry a link.
        await expect(renameInVault(pair.A, OLD, NEW)).rejects.toThrow(
          "Destination file already exists",
        );
        await renameInVault(pair.A, OLD, MID);
        await waitForContent(pair.A, pair.B, MID, CONTENT, 120_000);
        await renameInVault(pair.A, MID, NEW);
      } else {
        await renameInVault(pair.A, OLD, NEW);
      }

      const hop = [
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ];
      await expectRenameLinks(pair.server, phoneAsA ? [...hop, ...hop] : hop);

      const [newHash] = await pathHashesOf(pair.A, [NEW]);
      expect(serverChain(pair.server, oldHash).at(-1)).toEqual({
        version: 2,
        deleted: 1,
        rename_mark: 1,
      });
      expect(serverChain(pair.server, newHash)).toEqual([
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

      for (const device of [pair.A, pair.B]) {
        // Exactly one entry, spelled the new way: on a case-insensitive filesystem the old
        // spelling still resolves, so count the folder's own names instead of probing paths.
        await expect
          .poll(
            async () =>
              (await folderFiles(device, "notes")).filter((name) =>
                name.toLowerCase() === "case-test.md"
              ).length,
            { timeout: 120_000 },
          )
          .toBe(1);
        expect(await folderFiles(device, "notes")).toEqual(["Case-Test.md"]);
        expect(await device.readVaultFile(NEW)).toBe(CONTENT);
      }
      expect(serverTrashCount(pair.server.dataDir, pair.server.vaultId)).toBe(trashBefore);

      await showInExplorer(pair.A, NEW);
      await pair.A.screenshot("587-rename-case-A.png");
      await showInExplorer(pair.B, NEW);
      await pair.B.screenshot("587-rename-case-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
