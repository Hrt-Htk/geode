import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { readVaultFile, writeVaultFile } from "../helpers/editor";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #584 (hybrid): a note moved into a folder excluded from sync (#342) and later back
// out keeps ONE history: the parked name closes with a rename marker naming where the
// file went, and the destination's first version is its note. Real Obsidian on the
// phone drives the move (real rename events), the desktop proves the outcome.
const PASSPHRASE = "parked-move-passphrase";
const OLD_PATH = "notes/parked.md";
const PARKED_PATH = "Archive/parked.md";
const NEW_PATH = "notes/returned.md";
const CONTENT = "# parked\nmoved into an excluded folder\n";
const EDITED = "# parked\nedited inside the excluded folder\n";

type RenameRow = { version: number; deleted: number; rename_mark: number };

function renameRows(dataDir: string, vaultId: string): RenameRow[] {
  const db = new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND rename_mark != 0 ORDER BY seq",
      )
      .all(vaultId) as RenameRow[];
  } finally {
    db.close();
  }
}

const q = (value: string) => JSON.stringify(value);

test("a note parked in an excluded folder and moved back keeps one history", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(300_000);

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const phone = pair.B;
  const desktop = pair.A;
  try {
    await expect
      .poll(async () => await desktop.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await expect
      .poll(async () => await phone.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await waitForStatusBar(desktop, "Geode: synced", 60_000);
    await waitForStatusBar(phone, "Geode: synced", 60_000);

    await writeVaultFile(desktop, OLD_PATH, CONTENT);
    await desktop.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${q(OLD_PATH)}, kind: "commit" },
      ]);
      return true;
    `);
    await waitForConvergence(desktop, phone, OLD_PATH, 60_000);

    // The phone switches Archive/ off, moves the note in, and edits it there.
    await phone.eval(`
      const plugin = app.plugins.plugins.geode;
      plugin.pluginSettings.excludedFolders = ["Archive/"];
      await plugin.saveSettings();
      if (!(await app.vault.adapter.exists("Archive"))) await app.vault.createFolder("Archive");
      const file = app.vault.getAbstractFileByPath(${q(OLD_PATH)});
      if (!file) throw new Error("phone must hold the note before the move");
      await app.vault.rename(file, ${q(PARKED_PATH)});
      return true;
    `);
    await phone.eval(`
      const file = app.vault.getAbstractFileByPath(${q(PARKED_PATH)});
      await app.vault.modify(file, ${q(EDITED)});
      return true;
    `);
    // While excluded nothing left the phone: the desktop still holds the old name and
    // the server has no rename link yet.
    await expect
      .poll(() => renameRows(pair.server.dataDir, pair.server.vaultId), { timeout: 30_000 })
      .toEqual([]);
    expect(await readVaultFile(desktop, OLD_PATH)).toBe(CONTENT);

    // Moving it back out is the second half: one marker + one note, edited content.
    await phone.eval(`
      const file = app.vault.getAbstractFileByPath(${q(PARKED_PATH)});
      if (!file) throw new Error("the parked note must still be on the phone");
      await app.vault.rename(file, ${q(NEW_PATH)});
      return true;
    `);
    await expect
      .poll(() => renameRows(pair.server.dataDir, pair.server.vaultId), { timeout: 120_000 })
      // The parked name closes with a marker (its version 2) and the destination's
      // FIRST version is its note (version 1): one history window, not two.
      .toEqual([
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

    // The desktop follows the link: only the new name, with the edit made while parked.
    await expect
      .poll(
        async () => await desktop.eval<boolean>(`await app.vault.adapter.exists(${q(NEW_PATH)})`),
        { timeout: 120_000 },
      )
      .toBe(true);
    expect(await readVaultFile(desktop, NEW_PATH)).toBe(EDITED);
    await expect
      .poll(
        async () => await desktop.eval<boolean>(`await app.vault.adapter.exists(${q(OLD_PATH)})`),
        { timeout: 120_000 },
      )
      .toBe(false);
    expect(await phone.eval<string[]>("app.vault.getFiles().map((f) => f.path)")).not.toContain(
      OLD_PATH,
    );

    // The parked move is consumed, so nothing re-resolves it on the next start.
    expect(
      await phone.eval<number>("app.plugins.plugins.geode.pluginSettings.pendingMoveOuts.length"),
    ).toBe(0);

    expect(await phone.consoleErrors()).toEqual([]);
  } finally {
    await phone.eval(`
      const plugin = app.plugins.plugins.geode;
      plugin.pluginSettings.excludedFolders = [];
      await plugin.saveSettings();
      return true;
    `).catch(() => undefined);
    await pair.stop();
  }
});
