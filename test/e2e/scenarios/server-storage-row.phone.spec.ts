import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #341/#553 (phone): the settings Status section shows the server storage row
// ("This vault X · Y free") on-device. Mirrors the desktop #341 normal
// state; the row is driven by the same storage-client + status logic.
const PASSPHRASE = "server-storage-row-phone-pass";

const STORAGE_ROW = '[data-testid="geode-settings-storage"]';
// Server-answered state: real usage line or the low-space warning (see the desktop
// #341 spec: the E2E server's /tmp data dir here has < 5 GB free → warning).
const SERVER_ANSWERED =
  /^(This vault [\d.]+ (KB|MB|GB|TB) · [\d.]+ (KB|MB|GB|TB) free|This vault [\d.]+ (KB|MB|GB|TB) · Low on server space\. [\d.]+ (KB|MB|GB|TB) free\.)$/;

test("server storage (phone): row visible with normal text", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("server-storage-row");

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
    /* Wait for locked state, then unlock via eval. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* Synced baseline so the sync loop isn't racing us. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* Open the settings tab (no leading app.setting.close() on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const row = obsidian.win.locator(STORAGE_ROW);
    await row.waitFor({ timeout: 15_000 });
    await expect.poll(
      async () => await row.locator(".setting-item-description").textContent(),
      { timeout: 30_000 },
    ).toMatch(SERVER_ANSWERED);

    /* adb screencap of the whole screen. */
    await obsidian.screenshot(shotPath("341-phone-01.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
