import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import {
  serverDeviceCount,
  serverDeviceName,
  unlockIfLocked,
  waitForServerState,
} from "../helpers/interrupt";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #493 flow d (phone, #433): EXPECTED: the phone is force-stopped mid devices rename (server
// row renamed) → a relaunch shows the new name in the Devices view: server and UI agree.
// Force-stop mid devices revoke (server row gone) → a relaunch shows the revoked device
// absent from the Devices view: server and UI agree.
const PASSPHRASE = "interrupt-devices-phone-pass";
const NEW_NAME = "interrupt-phone-renamed";

async function unlockAndSync(obsidian: PhoneInstance): Promise<void> {
  await expect
    .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
    .toBe("Geode: locked");
  await obsidian.eval(
    `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
  );
  await waitForUnlocked(obsidian);
  await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);
  await dismissModals(obsidian);
}

async function openDevicesView(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`
    app.setting.open();
    app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
    return true;
  `);
  await obsidian.win.locator('[data-testid="geode-settings-devices-manage"]').waitFor({
    timeout: 15_000,
  });
  await evalClick(obsidian, '[data-testid="geode-settings-devices-manage"]');
  await expect(obsidian.win.locator('[data-testid="geode-devices-modal"]')).toBeVisible({
    timeout: 15_000,
  });
  await obsidian.win.locator('[data-testid="geode-device-row"]').first().waitFor({
    timeout: 15_000,
  });
}

test("issue493 (phone): force-stop mid devices rename → relaunch → Devices view shows the new name", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-devices-phone");

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
    await unlockAndSync(obsidian);

    /* Rename this device from the real Devices view. */
    await openDevicesView(obsidian);
    await evalClick(obsidian, '[data-testid="geode-device-rename"]');
    await evalSetValue(obsidian, '[data-testid="geode-device-rename-input"]', NEW_NAME);
    await evalClick(obsidian, '[data-testid="geode-device-rename-confirm"]');

    /* Deterministic mid-rename signal: the server row is renamed. */
    await waitForServerState(
      () => serverDeviceName(dataDir, server.vaultId, device.deviceId),
      (n) => n === NEW_NAME,
      30_000,
      "device renamed on the server",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* Server and UI agree: the row shows the new name. */
      await openDevicesView(obsidian2);
      const row = obsidian2.win.locator('[data-testid="geode-device-row"]', { hasText: NEW_NAME });
      await expect(row).toBeVisible({ timeout: 15_000 });
      expect(await row.locator(".geode-device-name").textContent()).toContain("(this device)");
      await obsidian2.screenshot(shotPath("493-devices-rename-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});

test("issue493 (phone): force-stop mid devices revoke → relaunch → Devices view matches the server", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-devices-phone");
  /* A second device so the vault has a plain (revocable) row alongside the phone's own. */
  await server.mintToken("interrupt-devices-phone-other");

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
    await unlockAndSync(obsidian);

    /* Revoke the other device from the phone's real Devices view (admin-token gated). */
    await openDevicesView(obsidian);
    await obsidian.eval(`
      (() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="geode-device-row"]'));
        const row = rows.find(
          (r) => (r.querySelector(".geode-device-name")?.textContent || "").includes(${
      JSON.stringify("interrupt-devices-phone-other")
    }),
        );
        if (!row) throw new Error("device row not found");
        row.querySelector('[data-testid="geode-device-revoke"]')?.click();
        return true;
      })()
    `);
    await evalSetValue(obsidian, '[data-testid="geode-admin-token-input"]', "e2e");
    await evalClick(obsidian, '[data-testid="geode-admin-token-continue"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');

    /* Deterministic mid-revoke signal: the other device's server row is gone. */
    await waitForServerState(
      () => serverDeviceCount(dataDir, server.vaultId),
      (n) => n === 1,
      30_000,
      "revoked device row gone from the server",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* Server and UI agree: only the phone's row remains. */
      await openDevicesView(obsidian2);
      const rows = obsidian2.win.locator('[data-testid="geode-device-row"]');
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      expect(await rows.first().locator(".geode-device-name").textContent()).toContain(
        "(this device)",
      );
      await obsidian2.screenshot(shotPath("493-devices-revoke-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
