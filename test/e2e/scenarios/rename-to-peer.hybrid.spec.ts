import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { readVaultFile, writeVaultFile } from "../helpers/editor";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #583 (hybrid): a real rename on desktop must reach the phone as a MOVE, not a
// delete + create: the phone ends with only the new name, and the server holds one
// marker (old path, deleted + rename_mark 1) and one note (new path, rename_mark 2),
// with no trash entry (a marker is never a deletion).
const PASSPHRASE = "rename-passphrase";
const OLD_PATH = "notes/rename-me.md";
const NEW_PATH = "notes/renamed-note.md";
const CONTENT = "# rename me\nhistory follows the note\n";

type RenameRow = { version: number; deleted: number; rename_mark: number };

function renameState(dataDir: string, vaultId: string): { rows: RenameRow[]; trash: number } {
  const db = new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND rename_mark != 0 ORDER BY seq",
      )
      .all(vaultId) as RenameRow[];
    const trash = db
      .prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return { rows, trash: trash.n };
  } finally {
    db.close();
  }
}

// The desktop renames AND edits while the phone is paused holding its own edit of the
// old name: the phone's edit must follow the note (merge) and the old name must not
// come back on either device.
test("rename + a concurrent offline edit on the other device keeps both edits", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(300_000);

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const phone = pair.B;
  try {
    await expect
      .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await expect
      .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await waitForStatusBar(pair.A, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B, "Geode: synced", 60_000);

    await writeVaultFile(pair.A, OLD_PATH, "one\ntwo\nthree\n");
    await pair.A.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(OLD_PATH)}, kind: "commit" },
      ]);
      return true;
    `);
    await waitForConvergence(pair.A, pair.B, OLD_PATH, 60_000);

    // The phone goes offline and edits the old name locally.
    await phone.eval(`app.plugins.plugins.geode.syncManager.pause(); return true;`);
    await phone.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(OLD_PATH)});
      if (!file) throw new Error("phone must have the note before it pauses");
      await app.vault.modify(file, "one PHONE\\ntwo\\nthree\\n");
      return true;
    `);
    await phone.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(OLD_PATH)}, kind: "commit" },
      ]);
      return true;
    `);

    // The desktop renames and edits the same note.
    await pair.A.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(OLD_PATH)});
      if (!file) throw new Error("desktop must have the note before it renames");
      await app.vault.modify(file, "one\\ntwo\\nthree DESKTOP\\n");
      await app.vault.rename(file, ${JSON.stringify(NEW_PATH)});
      return true;
    `);
    await expect
      .poll(() => renameState(pair.server.dataDir, pair.server.vaultId).rows, { timeout: 120_000 })
      .toEqual([
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

    await phone.eval(`await app.plugins.plugins.geode.syncManager.resume(); return true;`);

    // Both edits survive: the phone's edit either merged into the new name or is in a
    // sibling conflict file; the old name is gone on both devices.
    await expect
      .poll(async () => {
        const contents = await phone.eval<string[]>(`
          const out = [];
          for (const f of app.vault.getFiles()) out.push(f.path + "\\u0000" + await app.vault.cachedRead(f));
          return out;
        `);
        return contents.join("|").includes("one PHONE");
      }, { timeout: 120_000 })
      .toBe(true);
    await expect
      .poll(
        async () =>
          await phone.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(OLD_PATH)})`),
        { timeout: 120_000 },
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          await pair.A.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(OLD_PATH)})`),
        { timeout: 120_000 },
      )
      .toBe(false);
    expect(await readVaultFile(pair.A, NEW_PATH)).toContain("three DESKTOP");
    expect(await phone.eval<string[]>(`app.vault.getFiles().map((f) => f.path)`))
      .toContain(NEW_PATH);
    expect(renameState(pair.server.dataDir, pair.server.vaultId).trash).toBe(0);
    expect(await phone.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`rename reaches the other device as a move, not delete+create (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });
    try {
      await expect
        .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await expect
        .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await waitForStatusBar(pair.A, "Geode: synced", 60_000);
      await waitForStatusBar(pair.B, "Geode: synced", 60_000);

      await writeVaultFile(pair.A, OLD_PATH, CONTENT);
      await pair.A.eval(`
        await app.plugins.plugins.geode.syncManager.handlePendingOps([
          { path: ${JSON.stringify(OLD_PATH)}, kind: "commit" },
        ]);
        return true;
      `);
      await waitForConvergence(pair.A, pair.B, OLD_PATH, 60_000);

      // The real rename API: the plugin's own rename event must write the link.
      await pair.A.eval(`
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(OLD_PATH)});
        if (!file) throw new Error("expected the note to rename: " + ${JSON.stringify(OLD_PATH)});
        await app.vault.rename(file, ${JSON.stringify(NEW_PATH)});
        return true;
      `);

      // One marker on the old name + one note opening the new one, on both roles.
      await expect
        .poll(
          () => renameState(pair.server.dataDir, pair.server.vaultId).rows,
          { timeout: 120_000 },
        )
        .toEqual([
          { version: 2, deleted: 1, rename_mark: 1 },
          { version: 1, deleted: 0, rename_mark: 2 },
        ]);

      await expect
        .poll(
          async () =>
            await pair.B.eval<boolean>(
              `await app.vault.adapter.exists(${JSON.stringify(OLD_PATH)})`,
            ),
          { timeout: 120_000 },
        )
        .toBe(false);
      await expect
        .poll(
          async () =>
            await pair.B.eval<boolean>(
              "app.plugins.plugins.geode.state.getLocalFile(" +
                JSON.stringify(OLD_PATH) + ")?.deleted === true",
            ),
          { timeout: 120_000 },
        )
        .toBe(true);
      expect(await waitForConvergence(pair.A, pair.B, NEW_PATH, 120_000)).toBe(CONTENT);
      expect(await readVaultFile(pair.B, NEW_PATH)).toBe(CONTENT);
      expect(renameState(pair.server.dataDir, pair.server.vaultId).trash).toBe(0);
      expect(await pair.B.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}

// #583 PR 3: a rename the event stream never saw is paired by the reconciler. The
// phone's sync is paused (the app is closed as far as commits and the vault scan are
// concerned) and the note is moved with the adapter, which fires no vault event; on
// resume only the reconciler can tell this was a rename, and it must write the same
// marker + note. Both devices end with only the new name.
const MISSED_OLD_PATH = "notes/missed-rename.md";
const MISSED_NEW_PATH = "notes/missed-renamed.md";
const MISSED_CONTENT = "# missed rename\nonly the reconciler saw this one\n";

test("a rename the event stream missed is paired into marker + note", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const phone = pair.B;
  try {
    await expect
      .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await expect
      .poll(async () => await phone.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await waitForStatusBar(pair.A, "Geode: synced", 60_000);
    await waitForStatusBar(phone, "Geode: synced", 60_000);

    await writeVaultFile(pair.A, MISSED_OLD_PATH, MISSED_CONTENT);
    await pair.A.eval(`
      await app.plugins.plugins.geode.syncManager.handlePendingOps([
        { path: ${JSON.stringify(MISSED_OLD_PATH)}, kind: "commit" },
      ]);
      return true;
    `);
    await waitForConvergence(pair.A, phone, MISSED_OLD_PATH, 60_000);

    // Stop syncing on the phone, move the file on disk (no create/delete/rename event),
    // then start again: the missed rename reaches the server only through a reconcile.
    await phone.eval(`app.plugins.plugins.geode.syncManager.pause(); return true;`);
    await phone.eval(`
      await app.vault.adapter.rename(
        ${JSON.stringify(MISSED_OLD_PATH)},
        ${JSON.stringify(MISSED_NEW_PATH)},
      );
      return true;
    `);
    await phone.eval(`await app.plugins.plugins.geode.syncManager.resume(); return true;`);
    await expect
      .poll(async () =>
        await phone.eval<boolean>(
          `typeof app.plugins.plugins.geode.syncManager.reconcileNow === "function"`,
        )
      )
      .toBe(true);
    // The reconciler's own timer is 5 minutes: force the pass a couple of times, which
    // is what "Reconcile now" and the app-start pass do.
    await phone.eval(`await app.plugins.plugins.geode.syncManager.reconcileNow(); return true;`);

    // One marker on the old name + one note opening the new one: not a delete + create.
    await expect
      .poll(
        async () => {
          await phone.eval(
            `await app.plugins.plugins.geode.syncManager.reconcileNow(); return true;`,
          );
          return renameState(pair.server.dataDir, pair.server.vaultId).rows;
        },
        { timeout: 120_000 },
      )
      .toEqual([
        { version: 2, deleted: 1, rename_mark: 1 },
        { version: 1, deleted: 0, rename_mark: 2 },
      ]);

    expect(renameState(pair.server.dataDir, pair.server.vaultId).trash).toBe(0);
    await expect
      .poll(
        async () =>
          await pair.A.eval<boolean>(
            `await app.vault.adapter.exists(${JSON.stringify(MISSED_OLD_PATH)})`,
          ),
        { timeout: 120_000 },
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          await phone.eval<boolean>(
            `await app.vault.adapter.exists(${JSON.stringify(MISSED_OLD_PATH)})`,
          ),
        { timeout: 120_000 },
      )
      .toBe(false);
    expect(await waitForConvergence(pair.A, phone, MISSED_NEW_PATH, 120_000)).toBe(MISSED_CONTENT);
    expect(await readVaultFile(phone, MISSED_NEW_PATH)).toBe(MISSED_CONTENT);
    expect(await phone.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
