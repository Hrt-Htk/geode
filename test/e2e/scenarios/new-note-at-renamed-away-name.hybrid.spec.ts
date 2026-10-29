import { expect, test } from "@playwright/test";
import {
  folderFiles,
  launchSyncedPair,
  pathHashesOf,
  renameInVault,
  seedNote,
  serverChain,
} from "../helpers/rename-links";

// #695: the phone renames a note away from "Untitled", then a new note on the desktop
// (Ctrl+N) reuses the free name. It must stay a new note: never be carried into the
// renamed note as a "(conflict …)" copy.
const PASSPHRASE = "new-note-renamed-away";
const UNTITLED = "Untitled.md";
const RENAMED = "Ggf fhj.md";
const CONTENT = "phone note\n";

test("a new note at a name the other device renamed away stays a new note", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchSyncedPair(PASSPHRASE, true);
  const phone = pair.A;
  const desktop = pair.B;
  try {
    await seedNote(phone, desktop, UNTITLED, CONTENT);
    await renameInVault(phone, UNTITLED, RENAMED);
    await expect.poll(() => desktop.fileExists(UNTITLED), { timeout: 120_000 }).toBe(false);
    await expect.poll(() => desktop.fileExists(RENAMED), { timeout: 120_000 }).toBe(true);
    const [untitledHash] = await pathHashesOf(desktop, [UNTITLED]);
    const markerVersion = serverChain(pair.server, untitledHash).at(-1)!.version;

    await desktop.win.keyboard.press("Control+N");
    await desktop.win.keyboard.type("abc", { delay: 100 });

    // Settled: the new note either reached the server under its own name, or the bug
    // carried it away into a conflict copy.
    const settled = async () =>
      serverChain(pair.server, untitledHash).some((row) => row.version > markerVersion) ||
      (await folderFiles(desktop, "")).some((f) => f.includes("(conflict "));
    await expect.poll(settled, { timeout: 60_000 }).toBe(true);
    await desktop.screenshot("695-desktop-after-new-note.png");

    expect((await folderFiles(desktop, "")).filter((f) => f.includes("(conflict "))).toEqual([]);
    expect(await desktop.fileExists(UNTITLED)).toBe(true);
    expect(await desktop.readVaultFile(RENAMED)).toBe(CONTENT);
    await expect.poll(() => phone.fileExists(UNTITLED), { timeout: 120_000 }).toBe(true);

    expect(await desktop.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
