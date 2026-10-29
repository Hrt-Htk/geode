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

// #587 item 3: moving a folder with five notes must land as five moves on the other
// device: every file at its new path, one marker + one note per file, no duplicate and
// no leftover at the old path.
const PASSPHRASE = "rename-folder";
const SRC = "src";
const DST = "moved";
const NOTES = ["01-alpha", "02-beta", "03-gamma", "04-delta", "05-epsilon"];

const body = (name: string) => `# ${name}\nmoved as a whole folder\n`;

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`folder move carries every note and nothing else (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.setTimeout(420_000);

    const pair = await launchSyncedPair(PASSPHRASE, phoneAsA);
    try {
      const trashBefore = serverTrashCount(pair.server.dataDir, pair.server.vaultId);
      const oldPaths = NOTES.map((name) => `${SRC}/${name}.md`);
      for (const oldPath of oldPaths) await seedNote(pair.A, pair.B, oldPath, body(oldPath));
      const oldHashes = await pathHashesOf(pair.A, oldPaths);

      await renameInVault(pair.A, SRC, DST);

      const newPaths = NOTES.map((name) => `${DST}/${name}.md`);
      for (const [index, newPath] of newPaths.entries()) {
        await waitForContent(pair.A, pair.B, newPath, body(oldPaths[index]), 120_000);
      }
      const newHashes = await pathHashesOf(pair.A, newPaths);

      // One marker + one note per file, and nothing else carrying a link.
      await expectRenameLinks(pair.server, [
        ...oldHashes.map(() => ({ version: 2, deleted: 1, rename_mark: 1 })),
        ...newHashes.map(() => ({ version: 1, deleted: 0, rename_mark: 2 })),
      ]);
      for (const [index, oldHash] of oldHashes.entries()) {
        expect(serverChain(pair.server, oldHash).at(-1)).toEqual({
          version: 2,
          deleted: 1,
          rename_mark: 1,
        });
        expect(serverChain(pair.server, newHashes[index])[0]).toEqual({
          version: 1,
          deleted: 0,
          rename_mark: 2,
        });
      }

      const names = NOTES.map((name) => `${name}.md`).sort();
      for (const device of [pair.A, pair.B]) {
        expect((await folderFiles(device, DST)).sort()).toEqual(names);
        expect(await folderFiles(device, SRC)).toEqual([]);
        for (const oldPath of oldPaths) expect(await device.fileExists(oldPath)).toBe(false);
      }
      expect(serverTrashCount(pair.server.dataDir, pair.server.vaultId)).toBe(trashBefore);

      await showInExplorer(pair.A, `${DST}/05-epsilon.md`);
      await pair.A.screenshot("587-rename-folder-A.png");
      await showInExplorer(pair.B, `${DST}/05-epsilon.md`);
      await pair.B.screenshot("587-rename-folder-B.png");

      expect(await pair.A.consoleErrors()).toEqual([]);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
