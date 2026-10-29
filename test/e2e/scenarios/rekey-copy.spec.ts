import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import {
  assertNoLogErrors,
  assertSeedFilesReadBack,
  assertSwitchLanded,
  runRekeyCopy,
  seedFiles,
  startRekeyRun,
  waitForRekeyProgress,
} from "../helpers/rekey";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { evalClick } from "../helpers/mobile-ui";
import { readGeodeStatusBar, waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #561 scope 1 (desktop): copy mode through the real modal: a run cancelled
// mid-run leaves the vault fully on the old keys (the old passphrase still
// unlocks) and syncing continues; a subsequent run to completion lands the
// switch (old passphrase dead, new one unlocks, files byte-identical).
const PASSPHRASE = "rekey-copy-pass";
const NEW_PASSPHRASE = "rekey-copy-new-pass";
const N = 4;
const CANCEL_NOTE = "notes/rekey-cancel.md";
const CANCEL_CONTENT = "survived the cancel\n";

test("issue561 rekey copy: cancel mid-run keeps old keys + sync; a full run switches", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await Promise.all([
      waitForUnlocked(pair.A),
      waitForUnlocked(pair.B),
      waitForStatusBar(pair.A.win, "Geode: synced", 60_000),
      waitForStatusBar(pair.B.win, "Geode: synced", 60_000),
    ]);

    await seedFiles(pair.A, N);
    await waitForStatusBar(pair.A.win, "Geode: synced", 120_000);

    /* ---- Cancel mid-run: the vault stays on the old keys ---- */
    await startRekeyRun(pair.A, PASSPHRASE, NEW_PASSPHRASE, "copy");
    console.log("PROGRESS:", await waitForRekeyProgress(pair.A));
    await evalClick(pair.A, '[data-testid="geode-rekey-cancel"]');

    // The modal returns to the change form and the cursor is cleared.
    await expect
      .poll(
        () =>
          pair.A.eval<boolean>(`!!document.querySelector('[data-testid="geode-rekey-current"]')`),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(
      await pair.A.eval<boolean>("app.plugins.plugins.geode.rekeyPaused()"),
      "cancel must clear the resume cursor",
    ).toBe(false);

    // The old passphrase still unlocks (the switch never landed).
    await pair.A.eval(`app.plugins.plugins.geode.lockVault(); return true;`);
    await expect.poll(async () => await readGeodeStatusBar(pair.A.win), { timeout: 15_000 }).toBe(
      "Geode: locked",
    );
    await pair.A.eval(`app.commands.executeCommandById("geode:geode-unlock"); return true;`);
    const unlockModal = pair.A.win.locator('.modal:has([data-testid="geode-passphrase-input"])');
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await unlockModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await unlockModal.locator('[data-testid="geode-passphrase-submit"]').click();
    await expect(unlockModal).not.toBeVisible({ timeout: 30_000 });
    await waitForUnlocked(pair.A, 30_000);

    // And it keeps syncing: an edit on A converges to B.
    await upsertVaultFile(pair.A, CANCEL_NOTE, CANCEL_CONTENT);
    await commitPath(pair.A, CANCEL_NOTE);
    expect(await waitForConvergence(pair.A, pair.B, CANCEL_NOTE, 90_000)).toBe(CANCEL_CONTENT);

    /* ---- Run to completion: the switch lands ---- */
    await runRekeyCopy(pair.A, PASSPHRASE, NEW_PASSPHRASE);
    await waitForStatusBar(pair.A.win, "Geode: synced", 120_000);

    await assertSwitchLanded(pair.A, PASSPHRASE, NEW_PASSPHRASE);
    await assertSeedFilesReadBack(pair.A, N);

    /* ---- Log oracle ---- */
    await assertNoLogErrors(pair.A, "A LOG ERRORS");
  } finally {
    await pair.stop();
  }
});
