import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import {
  assertSwitchLanded,
  resumeRekeyRun,
  seedContent,
  seedFiles,
  startRekeyRun,
  waitForRekeyProgress,
} from "../helpers/rekey";
import { unlockIfLocked } from "../helpers/interrupt";
import { evalClick } from "../helpers/mobile-ui";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

// #561 scope 3 (phone): force-stop mid-run in both modes (the #493 phone
// kill): the app is force-stopped while a re-key run is paused mid-blobs
// (cursor persisted, server session open); after a relaunch the vault is
// still on the OLD keys (the old passphrase unlocks), the run resumes
// through the real modal's resume form to completion, and the vault is not
// mixed-key: every file on device decrypts to its pre-re-key bytes and the
// old passphrase is dead.
const PASSPHRASE = "rekey-interrupt-phone-pass";
const NEW_PASSPHRASE = "rekey-interrupt-phone-new-pass";
// 24 MB: the phone's re-key run is fast, so the seed must outlast the pause
// click after the first progress shows (a tiny vault re-keys before the kill
// can land).
const N = 8;

async function interruptCase(mode: "copy" | "replace"): Promise<void> {
  const server = await useRemoteServer();
  const device = await server.mintToken(`rekey-interrupt-phone-${mode}`);
  // #675: the seeded vault needs its re-key auth hash, as a real create/join registers it.
  await server.registerAuthHash(device.token, PASSPHRASE, TEST_ARGON2_PARAMS);

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    keepStartupModal: true,
  });

  try {
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);

    await seedFiles(obsidian, N);
    await waitForStatusBar(obsidian.win, "Geode: synced", 180_000);

    // Start the run and catch it mid-blobs: wait for real progress, then
    // pause, so the kill lands with part of the vault re-encrypted. If the
    // run finishes before progress shows, pause immediately: the pause's
    // cursor save is immediate, giving a deterministic mid-run state.
    // Then force-stop the app.
    await startRekeyRun(obsidian, PASSPHRASE, NEW_PASSPHRASE, mode);
    let progress = "";
    try {
      progress = await waitForRekeyProgress(obsidian);
    } catch {
      // The run finished before progress showed; fall back to an immediate pause.
    }
    console.log(`[${mode}] PAUSED at:`, progress);
    await evalClick(obsidian, '[data-testid="geode-rekey-pause"]');
    await expect
      .poll(
        () =>
          obsidian.eval<string>(
            `document.querySelector('[data-testid="geode-rekey-progress"]')?.textContent ?? ""`,
          ),
        { timeout: 30_000 },
      )
      .toBe("Rekey paused");

    await obsidian.forceStop();
    const obsidian2 = await obsidian.relaunch();

    try {
      // The vault is still on the old keys: the old passphrase unlocks.
      await unlockIfLocked(obsidian2, PASSPHRASE, 60_000);
      expect(
        await obsidian2.eval<boolean>("app.plugins.plugins.geode.rekeyPaused()"),
        "the resume cursor must survive the force-stop",
      ).toBe(true);

      // Resume through the real modal (resume form) to completion.
      await resumeRekeyRun(obsidian2, PASSPHRASE, NEW_PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 180_000);

      // No mixed-key vault: every file on device decrypts to pre-re-key bytes.
      for (let i = 1; i <= N; i++) {
        const got = await obsidian2.eval<string>(
          `await app.vault.adapter.read(${JSON.stringify(`seed-${i}.md`)})`,
        );
        expect(got, `${mode}: phone disk file ${i} after resume`).toBe(seedContent());
      }

      // The switch landed: old passphrase dead, new one unlocks.
      await assertSwitchLanded(obsidian2, PASSPHRASE, NEW_PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      const errors = await obsidian2.eval<Array<{ level: string; msg: string }>>(
        `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
      );
      console.log(
        `=== ${mode.toUpperCase()} PHONE LOG ERRORS ===\n` +
          (errors.length ? JSON.stringify(errors, null, 2) : "(none)"),
      );
      expect(errors).toEqual([]);
    } finally {
      await obsidian2.close();
    }
  } finally {
    await server.stop().catch(() => {});
  }
}

test("issue561 rekey interrupt (copy, phone): force-stop mid-run → relaunch → resume → no mixed-key vault", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);
  await interruptCase("copy");
});

test("issue561 rekey interrupt (replace, phone): force-stop mid-run → relaunch → resume → no mixed-key vault", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);
  await interruptCase("replace");
});
