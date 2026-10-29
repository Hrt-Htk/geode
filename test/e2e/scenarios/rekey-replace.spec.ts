import { test } from "@playwright/test";
import { launchObsidian, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import {
  assertNoLogErrors,
  assertSeedFilesReadBack,
  assertSwitchLanded,
  seedFiles,
  startRekeyRun,
  waitForRekeyProgress,
  waitForRekeySuccess,
} from "../helpers/rekey";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

// #561 scope 2 (desktop): replace mode through the real modal, run to
// completion: the switch lands (old passphrase dead, new one unlocks), every
// seeded file reads back byte-identical, and the device returns to synced.
const PASSPHRASE = "rekey-replace-pass";
const NEW_PASSPHRASE = "rekey-replace-new-pass";
const N = 4;

test("issue561 rekey replace: run to completion, switch lands, content intact", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("rekey-replace");
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

    await startRekeyRun(inst, PASSPHRASE, NEW_PASSPHRASE, "replace");
    console.log("PROGRESS:", await waitForRekeyProgress(inst));
    await waitForRekeySuccess(inst);
    await waitForStatusBar(inst.win, "Geode: synced", 120_000);

    await assertSwitchLanded(inst, PASSPHRASE, NEW_PASSPHRASE);
    await assertSeedFilesReadBack(inst, N);
    await assertNoLogErrors(inst, "LOG ERRORS");
  } finally {
    await inst.close();
    await server.stop?.();
  }
});
