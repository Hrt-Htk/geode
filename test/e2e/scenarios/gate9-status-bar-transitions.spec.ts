import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate9-statusbar-passphrase";

test("gate9 status bar transitions through all states in real Obsidian", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("gate9-statusbar");

  /* 1. locked: start with modal, don't unlock yet */
  const obsidian = await launchObsidian({
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
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* 2. unlock drives transport start → (connecting) → live. The "connecting" sub-state is
       sub-250ms on localhost and cannot be reliably sampled via DOM polling, so we assert the
       observable outcome (synced) below rather than racing the transient. */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* 3. live / synced */
    const liveText = await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    expect(liveText).toMatch(/^Geode: synced · Last synced:/);

    /* 4. offline: shutdown server */
    await server.shutdown();

    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 60_000 },
    ).toMatch(/^Geode: offline · Retry in \d+s$/);

    /* 5. recovered: restart server */
    await server.restart();

    const recoveredText = await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    expect(recoveredText).toMatch(/^Geode: synced · Last synced:/);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
