import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #203: vault.trash() on the phone reaches the desktop as a .trash/<file> copy.

const PASSPHRASE = "trash-pass";
const FILE_PATH = "trash-mobile-sync.md";
const CONTENT =
  "# Trash mobile sync\nThis file is trashed on the phone and must propagate via the event handler.\n";

test(
  `trash mobile sync: phone-side vault.trash() propagates .trash/<file> copy to desktop via event handler`,
  async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA: true });

    try {
      // 1. Both devices unlocked and synced.
      await expect
        .poll(
          async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
          { timeout: 60_000 },
        )
        .toBe(true);
      await expect
        .poll(
          async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
          { timeout: 60_000 },
        )
        .toBe(true);
      await waitForStatusBar(pair.A, "Geode: synced", 60_000);
      await waitForStatusBar(pair.B, "Geode: synced", 60_000);

      // 2. A (phone) creates the file and commits.
      await upsertVaultFile(pair.A, FILE_PATH, CONTENT);
      await commitPath(pair.A, FILE_PATH, "commit");

      const syncedCreate = await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000);
      expect(syncedCreate).toBe(CONTENT);

      // 3. A (phone) trashes the file via vault.trash(file, false).
      //    The `false` argument forces the local .trash/ folder (not system trash).
      //    We do NOT call commitPath: the VaultEventHandler must auto-queue the .trash/ commit.
      await pair.A.eval(`
        const path = ${JSON.stringify(FILE_PATH)};
        const trashPath = ".trash/" + path;
        const trashFolder = ".trash";
        if (!(await app.vault.adapter.exists(trashFolder))) {
          await app.vault.createFolder(trashFolder);
        }
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) {
          throw new Error("expected file to trash: " + path);
        }
        await app.vault.trash(file, false);
        return !(await app.vault.adapter.exists(path));
      `);

      // 4. THE CRUX ASSERTION: the .trash/ copy must reach B (desktop) via the event handler
      //    within 60s (far below the ~5-min reconciler cycle).
      expect(await waitForConvergence(pair.A, pair.B, ".trash/" + FILE_PATH, 60_000)).toBe(CONTENT);

      // 5. The original path must converge to absent on both devices.
      expect(await waitForConvergence(pair.A, pair.B, FILE_PATH, 60_000)).toBeNull();
    } finally {
      await pair.stop();
    }
  },
);
