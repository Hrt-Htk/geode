import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #339 (phone): the settings tab shows "Cannot reach your Geode server" while
// the server is unreachable, and [Retry] recovers it. Mirrors the desktop
// #339 spec (steps 1-3); the dropped variant is desktop-only there.
// Real shutdown/restart requires the local throwaway server (GEODE_PHONE_HOST),
// where useRemoteServer wires adb reverse; against a remote server the
// lifecycle calls are no-ops.
const PASSPHRASE = "error-banner-phone-pass";

const BANNER = '[data-testid="geode-settings-error-banner"]';
const RETRY = '[data-testid="geode-settings-error-retry"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';

test("error banner (phone): unreachable → retry → recovered", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("error-banner");

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

    /* ---- 1. Open the settings tab (no leading app.setting.close() on mobile) ---- */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const statusRow = obsidian.win.locator(STATUS_ROW);
    await statusRow.waitFor({ timeout: 15_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 30_000,
      })
      .toMatch(/^Up to date\. Last backup /);

    const banner = obsidian.win.locator(BANNER);
    const bannerName = banner.locator(".geode-banner-name");
    const bannerDesc = banner.locator(".setting-item-description");

    /* Synced: no error banner. */
    await expect(banner).toHaveCount(0);

    /* ---- 2. Server unreachable: banner appears within ~25 s ---- */
    await server.shutdown();
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(bannerName).toHaveText("Cannot reach your Geode server");
    expect(await bannerDesc.textContent()).toMatch(
      /^Sync is paused until 127\.0\.0\.1:\d+ is reachable\. Last attempt /,
    );
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Offline\. Retrying in \d+ s\./);
    await obsidian.eval(
      `document.querySelector('.vertical-tab-content-container')?.scrollTo(0, 0); return true;`,
    );
    await obsidian.screenshot(shotPath("339-phone-01-unreachable.png"));

    /* ---- 3. Server back + [Retry]: banner gone, status row recovered ---- */
    await server.restart();
    await evalClick(obsidian, RETRY);
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 60_000,
      })
      .toMatch(/^Up to date\. Last backup /);
    await obsidian.screenshot(shotPath("339-phone-02-recovered.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
