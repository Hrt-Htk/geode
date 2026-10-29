import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { type HybridPair, launchHybridPair } from "../fixtures/hybrid-pair";
import { commitPath, waitForUnlocked } from "../helpers/geode";
import { writeVaultFile } from "../helpers/editor";
import { evalClick } from "../helpers/mobile-ui";
import { enterAdminToken } from "../helpers/admin-token";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #582: Delete forever from the real trash modal erases the file's history, not just
// its trash row: the client walks the History (across the rename) and the server erases
// those generations. The confirm copy says the past versions go too.
const PASSPHRASE = "trash-delete-forever-pass";
const OLD_PATH = "notes/erase-me.md";
const NEW_PATH = "notes/erased-note.md";

type ServerState = { versions: number; trash: number; marks: number };

function serverState(dataDir: string, vaultId: string): ServerState {
  const db = new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS versions,
                SUM(CASE WHEN rename_mark != 0 THEN 1 ELSE 0 END) AS marks
         FROM file_versions WHERE vault_id = ?`,
      )
      .get(vaultId) as { versions: number; marks: number };
    const trash = db
      .prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return { versions: row.versions, trash: trash.n, marks: row.marks ?? 0 };
  } finally {
    db.close();
  }
}

/** Two saves at the old name, a real rename, then a delete: one trash row, a whole chain. */
async function seedTrashedRename(pair: HybridPair): Promise<string> {
  await waitForUnlocked(pair.A);
  await waitForStatusBar(pair.A, "Geode: synced", 60_000);
  await waitForStatusBar(pair.B, "Geode: synced", 60_000);

  await writeVaultFile(pair.A, OLD_PATH, "# erase me\nfirst draft\n");
  await commitPath(pair.A, OLD_PATH);
  await waitForConvergence(pair.A, pair.B, OLD_PATH, 60_000);
  await writeVaultFile(pair.A, OLD_PATH, "# erase me\nsecond draft\n");
  await commitPath(pair.A, OLD_PATH);
  await expect
    .poll(() => serverState(pair.server.dataDir, pair.server.vaultId).versions, { timeout: 60_000 })
    .toBe(2);

  await pair.A.eval(`
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(OLD_PATH)});
    if (!file) throw new Error("expected the note to rename");
    await app.vault.rename(file, ${JSON.stringify(NEW_PATH)});
    return true;
  `);
  await expect
    .poll(() => serverState(pair.server.dataDir, pair.server.vaultId).marks, { timeout: 120_000 })
    .toBe(2);
  await waitForConvergence(pair.A, pair.B, NEW_PATH, 60_000);

  await pair.A.eval(`
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(NEW_PATH)});
    if (!file) throw new Error("expected the note to delete");
    await app.vault.delete(file);
    return true;
  `);
  await commitPath(pair.A, NEW_PATH, "delete");
  await expect
    .poll(() => serverState(pair.server.dataDir, pair.server.vaultId).trash, { timeout: 60_000 })
    .toBe(1);

  // The row's own path hash, off the client that holds the keys.
  return await pair.A.eval<string>(
    "(await app.plugins.plugins.geode.trash.list())[0].path_hash",
  );
}

/** What the erase must leave: no trash, no saves, and each name's own head row (the
 * tombstone, and the earlier name's marker) so the names keep their version order. */
async function expectErased(pair: HybridPair): Promise<void> {
  await expect
    .poll(() => serverState(pair.server.dataDir, pair.server.vaultId), { timeout: 60_000 })
    .toEqual({ versions: 2, trash: 0, marks: 1 });
  for (const device of [pair.A, pair.B]) {
    expect(await device.fileExists(NEW_PATH)).toBe(false);
    expect(await device.fileExists(OLD_PATH)).toBe(false);
  }
  expect(await pair.B.eval<string[]>("app.vault.getFiles().map((f) => f.path)"))
    .not.toContain(NEW_PATH);
}

test("delete forever (desktop): the trash modal erases the whole chain", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  try {
    const pathHash = await seedTrashedRename(pair);

    await pair.A.eval(`app.plugins.plugins.geode.openTrashModal(); return true;`);
    const purge = `[data-testid="geode-trash-purge"][data-path-hash="${pathHash}"]`;
    await expect
      .poll(
        async () =>
          await pair.A.eval<boolean>(`!!document.querySelector(${JSON.stringify(purge)})`),
        { timeout: 30_000 },
      )
      .toBe(true);
    await pair.A.eval(`document.querySelector(${JSON.stringify(purge)}).click(); return true;`);

    const message = ".geode-confirm-modal p";
    await expect
      .poll(
        async () =>
          await pair.A.eval<string>(
            `document.querySelector(${JSON.stringify(message)})?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toBe(
        '"notes/erased-note.md" and its past versions are permanently deleted from the server.',
      );
    await pair.A.screenshot("582-01-confirm-desktop.png");
    await pair.A.eval(
      `document.querySelector('[data-testid="geode-confirm-yes"]').click(); return true;`,
    );
    // #677: inside the server's retention floor the purge asks for the admin token first.
    await enterAdminToken(pair.A);

    await expectErased(pair);
    await expect
      .poll(
        async () =>
          await pair.A.eval<boolean>(
            "!!document.querySelector('[data-testid=\"geode-trash-empty\"]')",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await pair.A.screenshot("582-02-trash-empty-desktop.png");
    expect(await pair.A.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});

test("delete forever (phone): the same erase from the on-device trash modal", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA: true });
  const phone = pair.A;
  try {
    const pathHash = await seedTrashedRename(pair);

    await phone.eval(`app.plugins.plugins.geode.openTrashModal(); return true;`);
    const purge = `[data-testid="geode-trash-purge"][data-path-hash="${pathHash}"]`;
    await expect
      .poll(
        async () => await phone.eval<boolean>(`!!document.querySelector(${JSON.stringify(purge)})`),
        { timeout: 30_000 },
      )
      .toBe(true);
    await evalClick(phone, purge);

    const message = ".geode-confirm-modal p";
    await expect
      .poll(
        async () =>
          await phone.eval<string>(
            `document.querySelector(${JSON.stringify(message)})?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toBe(
        '"notes/erased-note.md" and its past versions are permanently deleted from the server.',
      );
    await phone.screenshot("582-03-confirm-phone.png");
    await evalClick(phone, '[data-testid="geode-confirm-yes"]');
    // #677: the phone asks for the admin token too; it is kept in memory for the session.
    await enterAdminToken(phone);

    await expectErased(pair);
    await expect
      .poll(
        async () =>
          await phone.eval<boolean>(
            "!!document.querySelector('[data-testid=\"geode-trash-empty\"]')",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await phone.screenshot("582-04-trash-empty-phone.png");
    expect(await phone.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
