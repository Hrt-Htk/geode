import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import {
  commitPath,
  disconnectSync,
  reconnectSync,
  upsertVaultFile,
  waitForUnlocked,
} from "../helpers/geode";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { computeVerifier } from "../helpers/verifier";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";
import { runRekeyCopy, seedFiles } from "../helpers/rekey";

// #560: the "passphrase changed elsewhere" recovery, end to end in real
// Obsidian on desktop + phone: desktop runs a copy re-key through the real
// modal, the phone reaches the locked "Passphrase changed elsewhere" state
// (screenshot captured), the phone unlocks with the new passphrase through the
// real UI, and both sides converge on a subsequent edit.
const PASSPHRASE = "rekey-elsewhere-pass";
const NEW_PASSPHRASE = "rekey-elsewhere-new-pass";
const FILE_PATH = "notes/gate560.md";
const BASE_CONTENT = "line 1\nline 2\nline 3";
const A_EDIT = "line 1\nA edited line 2\nline 3";
const B_EDIT = "line 1\nline 2\nB edited line 3";

test("rekey elsewhere: desktop re-keys, phone locks, phone unlocks, both converge", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const { A, B } = pair; // A = desktop, B = phone

  try {
    // 1. Both unlocked + synced.
    await Promise.all([
      waitForUnlocked(A),
      waitForUnlocked(B),
      waitForStatusBar(A, "Geode: synced", 60_000),
      waitForStatusBar(B, "Geode: synced", 60_000),
    ]);

    // 2. Seed real files and a shared note; converge so the phone has them.
    await seedFiles(A, 4);
    await upsertVaultFile(A, FILE_PATH, BASE_CONTENT);
    await commitPath(A, FILE_PATH);
    await waitForConvergence(A, B, FILE_PATH, 90_000);
    await waitForStatusBar(B, "Geode: synced", 60_000);

    // The fixture bypasses the join flow (which stores the passphrase verifier in
    // settings), so the phone has none: onHelloRekey can't compare the server's
    // verifier_hash against a local one and would treat the re-key as "ok". Store
    // a real verifier so the phone detects the passphrase change, as a joined
    // device would.
    const verifier = await computeVerifier(PASSPHRASE, pair.server.salt, TEST_ARGON2_PARAMS);
    await B.eval(`
      app.plugins.plugins.geode.pluginSettings.verifier = ${JSON.stringify(verifier)};
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    // 3. Desktop runs a copy re-key through the real modal.
    await runRekeyCopy(A, PASSPHRASE, NEW_PASSPHRASE);
    // The desktop kept the new keys: it returns to synced.
    await waitForStatusBar(A, "Geode: synced", 120_000);

    // 4. Phone reaches the "Passphrase changed elsewhere" locked state.
    await expect
      .poll(
        () =>
          B.eval<boolean>(
            "app.plugins.plugins.geode.rekeyElsewhere === true && !app.plugins.plugins.geode.isUnlockedCheck()",
          ),
        { timeout: 90_000 },
      )
      .toBe(true);

    // Open the phone's settings tab so the screenshot shows the state, then capture it.
    await dismissModals(B);
    await B.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await expect
      .poll(
        () =>
          B.eval<boolean>(
            `!!document.querySelector('[data-testid="geode-settings-sync-status"]')?.textContent?.includes('Passphrase changed elsewhere')`,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await B.screenshot("560-phone-passphrase-changed-elsewhere.png");

    // 5. Unlock the phone with the new passphrase through the real UI.
    await B.eval(`app.commands.executeCommandById("geode:geode-unlock"); return true;`);
    await expect
      .poll(
        () => B.eval<boolean>(`!!document.querySelector('[data-testid="geode-passphrase-input"]')`),
        { timeout: 15_000 },
      )
      .toBe(true);
    await evalSetValue(B, '[data-testid="geode-passphrase-input"]', NEW_PASSPHRASE);
    await evalClick(B, '[data-testid="geode-passphrase-submit"]');
    await waitForUnlocked(B, 60_000);
    await waitForStatusBar(B, "Geode: synced", 60_000);

    // 6. Edit a file on each side, truly concurrent (both based on the same
    // base): disconnect the phone so its edit is made before it sees A's, then
    // reconnect: the 3-way merge combines the non-overlapping edits.
    await disconnectSync(B);
    await upsertVaultFile(A, FILE_PATH, A_EDIT);
    await commitPath(A, FILE_PATH);
    await upsertVaultFile(B, FILE_PATH, B_EDIT);
    await reconnectSync(B);
    await commitPath(B, FILE_PATH);
    await waitForConvergence(A, B, FILE_PATH, 90_000);
    const aDisk = await A.readVaultFile(FILE_PATH);
    const bDisk = await B.readVaultFile(FILE_PATH);
    expect(aDisk).toBe(bDisk);
    expect(aDisk).toContain("A edited line 2");
    expect(aDisk).toContain("B edited line 3");

    // 7. Log oracle: no errors on either side.
    const aErrors = await A.eval<Array<{ level: string; msg: string }>>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
    );
    const bErrors = await B.eval<Array<{ level: string; msg: string }>>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
    );
    console.log(
      "=== A LOG ERRORS ===\n" + (aErrors.length ? JSON.stringify(aErrors, null, 2) : "(none)"),
    );
    console.log(
      "=== B LOG ERRORS ===\n" + (bErrors.length ? JSON.stringify(bErrors, null, 2) : "(none)"),
    );
    expect(aErrors).toEqual([]);
    expect(bErrors).toEqual([]);
  } finally {
    await pair.stop();
  }
});
