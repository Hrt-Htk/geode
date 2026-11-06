import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { evalClick, evalSetValue } from "../helpers/mobile-ui";
import { assertNoLogErrors, runRekeyCopy, seedFiles } from "../helpers/rekey";
import { computeVerifier } from "../helpers/verifier";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #53: the device that ran the re-key, in real Obsidian: files it saved before the re-key
// keep the old path hash in its rows until the go-live repair. The desktop re-keys, then
// deletes one older file and renames another, and the phone follows both.
const PASSPHRASE = "rekey-own-device-pass";
const NEW_PASSPHRASE = "rekey-own-device-new-pass";
const DELETED = "notes/older-deleted.md";
const RENAMED = "notes/older-renamed.md";
const RENAMED_TO = "notes/older-renamed-now.md";

test("rekey own device: older files delete and rename on the re-keying device, the phone follows", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const { A, B } = pair; // A = desktop, B = phone
  const onPhone = (path: string) =>
    B.eval<boolean>(`return await app.vault.adapter.exists(${JSON.stringify(path)})`);

  try {
    await Promise.all([
      waitForUnlocked(A),
      waitForUnlocked(B),
      waitForStatusBar(A, "Geode: synced", 60_000),
      waitForStatusBar(B, "Geode: synced", 60_000),
    ]);

    await seedFiles(A, 4);
    await upsertVaultFile(A, DELETED, "saved before the re-key");
    await commitPath(A, DELETED);
    await upsertVaultFile(A, RENAMED, "also saved before the re-key");
    await commitPath(A, RENAMED);
    await waitForConvergence(A, B, DELETED, 90_000);
    await waitForConvergence(A, B, RENAMED, 90_000);
    await waitForStatusBar(B, "Geode: synced", 60_000);

    // The fixture bypasses the join flow, so the phone stores no verifier and would not
    // see the re-key: store one, as a joined device has.
    const verifier = await computeVerifier(PASSPHRASE, pair.server.salt, TEST_ARGON2_PARAMS);
    await B.eval(`
      app.plugins.plugins.geode.pluginSettings.verifier = ${JSON.stringify(verifier)};
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    await runRekeyCopy(A, PASSPHRASE, NEW_PASSPHRASE);
    await waitForStatusBar(A, "Geode: synced", 120_000);

    await expect
      .poll(() => B.eval<boolean>("app.plugins.plugins.geode.rekeyElsewhere === true"), {
        timeout: 90_000,
      })
      .toBe(true);
    await B.eval(`app.commands.executeCommandById("geode:unlock"); return true;`);
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

    await A.eval(
      `await app.vault.delete(app.vault.getAbstractFileByPath(${JSON.stringify(DELETED)}))`,
    );
    await A.eval(
      `await app.vault.rename(app.vault.getAbstractFileByPath(${JSON.stringify(RENAMED)}), ${
        JSON.stringify(RENAMED_TO)
      })`,
    );

    await expect.poll(() => onPhone(DELETED), { timeout: 90_000 }).toBe(false);
    await expect.poll(() => onPhone(RENAMED_TO), { timeout: 90_000 }).toBe(true);
    await expect.poll(() => onPhone(RENAMED), { timeout: 90_000 }).toBe(false);
    expect(await B.readVaultFile(RENAMED_TO)).toBe("also saved before the re-key");

    await assertNoLogErrors(A, "A LOG ERRORS");
    await assertNoLogErrors(B, "B LOG ERRORS");
  } finally {
    await pair.stop();
  }
});
