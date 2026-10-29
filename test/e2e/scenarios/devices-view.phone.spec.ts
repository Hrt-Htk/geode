import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #433 (phone): on the real device: open the Devices view from the settings
// Devices section, assert the device-token list renders both devices, and
// screenshot. Mobile patterns: settings open without a leading
// app.setting.close(), in-page eval clicks (CDP actionability never settles).
const PASSPHRASE = "devices-view-phone-pass";
const SHOT = "433-phone-01-devices.png";

test("devices view (phone): device-token list renders both devices", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("phone");
  // A second device so the vault has a plain row alongside the phone's own row.
  await server.mintToken("phone-desktop");

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
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* Open the settings tab (no leading app.setting.close() on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await obsidian.win
      .locator('[data-testid="geode-settings-devices-manage"]')
      .waitFor({ timeout: 15_000 });
    await evalClick(obsidian, '[data-testid="geode-settings-devices-manage"]');

    const modal = obsidian.win.locator('[data-testid="geode-devices-modal"]');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const rows = modal.locator('[data-testid="geode-device-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await expect(rows).toHaveCount(2);
    const names = (await rows.locator(".geode-device-name").allTextContents()).map((n) => n.trim());
    console.log("=== DEVICES VIEW ROWS (PHONE) ===");
    for (const name of names) console.log(name);
    console.log("=== END ===");
    expect(names.some((n) => n.includes("phone"))).toBe(true);
    expect(names.some((n) => n.includes("phone-desktop"))).toBe(true);

    // Clear any Notice overlays so the shot shows the devices surface clean.
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath(SHOT));
    console.log("SCREENSHOT:", SHOT);
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
