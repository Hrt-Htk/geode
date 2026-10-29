import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate4-status-passphrase";

test("gate4 status bar reflects live offline and recovered connection states in real Obsidian", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("gate4-status-bar");
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );

    const liveText = await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    expect(liveText).toMatch(/^Geode: synced · Last synced:/);

    await server.shutdown();

    const offlineText = await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 60_000 },
    ).toMatch(/^Geode: offline · Retry in \d+s$/);
    expect(offlineText).toBeUndefined();

    await server.restart();
    const recoveredText = await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    expect(recoveredText).toMatch(/^Geode: synced · Last synced:/);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
