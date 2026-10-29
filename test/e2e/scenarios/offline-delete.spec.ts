import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { launchPair } from "../fixtures/pair";
import {
  waitForConvergence,
  waitForFileInExplorer,
  waitForFileMissingInExplorer,
  waitForStatusBar,
} from "../helpers/waits";

const PASSPHRASE = "passphrase";
const DELETED_FILE = "notes/offline-deleted.md";
const CONTROL_FILE = "notes/control.md";

/**
 * #505 regression: a synced file deleted on disk while Obsidian is closed must
 * still propagate as a delete. The reconciler's stat-verify must treat a null
 * adapter.stat (real Obsidian's missing-path contract) as absent, not present.
 */
test("offline delete on A propagates to B and the server; nothing else is deleted", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE, keepVaultA: true });
  let A2: Awaited<ReturnType<typeof launchObsidian>> | null = null;

  try {
    await expect
      .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await expect
      .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    // Seed two files on A and sync them to B.
    for (
      const [file, content] of [
        [DELETED_FILE, "# Offline\nwill be deleted while A is closed\n"],
        [CONTROL_FILE, "# Control\nmust survive\n"],
      ] as const
    ) {
      await pair.A.eval(`
        const path = ${JSON.stringify(file)};
        const content = ${JSON.stringify(content)};
        const folder = path.split("/").slice(0, -1).join("/");
        if (folder && !(await app.vault.adapter.exists(folder))) {
          await app.vault.createFolder(folder);
        }
        await app.vault.create(path, content);
        return true;
      `);
      await pair.A.eval(`
        await app.plugins.plugins.geode.syncManager.handlePendingOps([
          { path: ${JSON.stringify(file)}, kind: "commit" },
        ]);
        return true;
      `);
      await waitForConvergence(pair.A, pair.B, file, 60_000);
    }
    // Reveal both files in B's explorer (this build does not auto-render
    // entries) so the later explorer assertions are not vacuous.
    for (const file of [DELETED_FILE, CONTROL_FILE]) {
      await pair.B.eval(`
        const f = app.vault.getFileByPath(${JSON.stringify(file)});
        if (!f) throw new Error("expected synced file in vault index: " + ${JSON.stringify(file)});
        await app.workspace.getLeaf(true).openFile(f);
        await app.commands.executeCommandById("file-explorer:reveal-active-file");
        return true;
      `);
      await waitForFileInExplorer(pair.B.win, file, 30_000);
    }

    // Close A (vault kept on disk), delete the file offline, relaunch A.
    const vaultDir = pair.A.vaultDir;
    const aSettings = pair.A.settings;
    await pair.A.close();
    await rm(path.join(vaultDir, DELETED_FILE));

    A2 = await launchObsidian({
      geodeSettings: aSettings,
      unlockPassphrase: PASSPHRASE,
      vaultDir,
    });

    await expect
      .poll(async () => await A2.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);
    await waitForStatusBar(A2.win, "Geode: synced", 90_000);

    // The offline delete reaches B (via the server): file gone from disk and
    // the explorer entry removed.
    await expect
      .poll(() =>
        pair.B.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(DELETED_FILE)})`)
      )
      .toBe(false);
    await waitForFileMissingInExplorer(pair.B.win, DELETED_FILE, 90_000);
    // B's tracked row is tombstoned: proof the delete version came from the server.
    await expect
      .poll(() =>
        pair.B.eval<boolean>(
          `Boolean(app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
            JSON.stringify(DELETED_FILE)
          })?.deleted)`,
        )
      )
      .toBe(true);
    // Nothing else was deleted: the control file survives on both devices.
    await expect
      .poll(() =>
        Promise.all([
          pair.B.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(CONTROL_FILE)})`),
          A2.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(CONTROL_FILE)})`),
        ]).then(([b, a]) => b && a)
      )
      .toBe(true);
    await waitForFileInExplorer(pair.B.win, CONTROL_FILE, 30_000);
  } finally {
    await A2?.close();
    await pair.stop();
  }
});
