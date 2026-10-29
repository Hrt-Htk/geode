import { expect, test } from "@playwright/test";
import { launchObsidian, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import {
  assertNoLogErrors,
  assertSeedFilesReadBack,
  assertSwitchLanded,
  resumeRekeyRun,
  seedFiles,
  startRekeyRun,
  waitForRekeyProgress,
} from "../helpers/rekey";
import { waitForUnlocked } from "../helpers/geode";
import { relaunchDesktop, unlockIfLocked } from "../helpers/interrupt";
import { evalClick } from "../helpers/mobile-ui";
import { waitForStatusBar } from "../helpers/waits";

// #561 scope 3 (desktop): kill mid-run in both modes: the app is SIGKILLed
// while a re-key run is paused mid-blobs (cursor persisted, server session
// open); after a relaunch on the same dirs the vault is still on the OLD keys
// (the old passphrase unlocks), the run resumes through the real modal's
// resume form to completion, and the vault is not mixed-key: every file
// decrypts to its pre-re-key bytes and the old passphrase is dead.
const PASSPHRASE = "rekey-interrupt-pass";
const NEW_PASSPHRASE = "rekey-interrupt-new-pass";
const N = 8; // 24 MB: a real backlog, so the running state is catchable

async function interruptCase(mode: "copy" | "replace"): Promise<void> {
  const server = await startServer();
  const device = await server.mintToken(`rekey-interrupt-${mode}`);
  // #675: the seeded vault needs its re-key auth hash, as a real create/join registers it.
  await server.registerAuthHash(device.token, PASSPHRASE, TEST_ARGON2_PARAMS);
  const inst = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(inst);
    await waitForStatusBar(inst.win, "Geode: synced", 60_000);

    await seedFiles(inst, N);
    await waitForStatusBar(inst.win, "Geode: synced", 120_000);

    // Start the run, catch it mid-blobs, pause (cursor save is immediate on
    // pause: a deterministic mid-run state), then hard-kill the app.
    await startRekeyRun(inst, PASSPHRASE, NEW_PASSPHRASE, mode);
    console.log(`[${mode}] PROGRESS:`, await waitForRekeyProgress(inst));
    await evalClick(inst, '[data-testid="geode-rekey-pause"]');
    await expect
      .poll(
        () =>
          inst.eval<string>(
            `document.querySelector('[data-testid="geode-rekey-progress"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toBe("Rekey paused");
    const inst2 = await relaunchDesktop(inst);

    try {
      // The vault is still on the old keys: the old passphrase unlocks.
      await unlockIfLocked(inst2, PASSPHRASE);
      expect(
        await inst2.eval<boolean>("app.plugins.plugins.geode.rekeyPaused()"),
        "the resume cursor must survive the kill",
      ).toBe(true);

      // Resume through the real modal (resume form) to completion.
      await resumeRekeyRun(inst2, PASSPHRASE, NEW_PASSPHRASE);
      await waitForStatusBar(inst2.win, "Geode: synced", 120_000);

      // No mixed-key vault: every file decrypts to its pre-re-key bytes.
      await assertSeedFilesReadBack(inst2, N, `${mode}: after resume`);

      // The switch landed: old passphrase dead, new one unlocks.
      await assertSwitchLanded(inst2, PASSPHRASE, NEW_PASSPHRASE);
      await waitForStatusBar(inst2.win, "Geode: synced", 120_000);

      await assertNoLogErrors(inst2, `${mode.toUpperCase()} LOG ERRORS`);
    } finally {
      await inst2.close();
    }
  } finally {
    await server.stop?.();
  }
}

test("issue561 rekey interrupt (copy): kill mid-run → relaunch → resume → no mixed-key vault", async () => {
  test.slow();
  await interruptCase("copy");
});

test("issue561 rekey interrupt (replace): kill mid-run → relaunch → resume → no mixed-key vault", async () => {
  test.slow();
  await interruptCase("replace");
});
