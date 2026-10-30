import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { launchPair } from "../fixtures/pair";
import type { ObsidianInstance } from "../fixtures/obsidian";
import { waitForUnlocked } from "../helpers/geode";
import {
  relaunchDesktop,
  serverDeviceCount,
  serverDeviceName,
  unlockIfLocked,
  waitForServerState,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow d (desktop, #433): EXPECTED: the app is SIGKILLed mid devices rename (server row
// renamed) → a relaunch shows the new name in the Devices view: server and UI agree.
// Kill mid devices revoke (server row gone) → a relaunch shows the revoked device absent from
// the Devices view: server and UI agree.
const PASSPHRASE = "interrupt-devices-pass";
const NEW_NAME = "interrupt-renamed-device";

async function openDevicesView(o: ObsidianInstance): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
  await o.win.locator('[data-testid="geode-settings-devices-manage"]').click();
  await o.win.locator('[data-testid="geode-devices-modal"]').waitFor({ timeout: 15_000 });
  await o.win.locator('[data-testid="geode-device-row"]').first().waitFor({ timeout: 15_000 });
}

test("issue493: kill mid devices rename → relaunch → Devices view shows the new name", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE, keepVaultA: true });
  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);

    const deviceId = await pair.A.eval<string>("app.plugins.plugins.geode.pluginSettings.deviceId");

    /* Rename this device from the real Devices view. */
    await openDevicesView(pair.A);
    await pair.A.win.locator('[data-testid="geode-device-rename"]').click();
    await pair.A.win.locator('[data-testid="geode-device-rename-input"]').fill(NEW_NAME);
    await pair.A.win.locator('[data-testid="geode-device-rename-confirm"]').click();

    /* Deterministic mid-rename signal: the server row is renamed. */
    await waitForServerState(
      () => serverDeviceName(pair.server.dataDir, pair.server.vaultId, deviceId),
      (n) => n === NEW_NAME,
      30_000,
      "device renamed on the server",
    );

    const a2 = await relaunchDesktop(pair.A);
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* Server and UI agree: the row shows the new name. */
      await openDevicesView(a2);
      const row = a2.win.locator('[data-testid="geode-device-row"]', { hasText: NEW_NAME });
      await expect(row).toBeVisible({ timeout: 15_000 });
      expect(await row.locator(".geode-device-name").textContent()).toContain("(this device)");
      await a2.win.locator('[data-testid="geode-devices-modal"]').screenshot({
        path: shotPath("493-devices-rename-settled.png"),
      });
    } finally {
      await a2.close();
    }
  } finally {
    /* hardKill made A.close() a no-op for the dirs: remove them explicitly. */
    await pair.stop();
    await rm(pair.A.vaultDir, { recursive: true, force: true });
    await rm(pair.A.userDataDir, { recursive: true, force: true });
  }
});

test("issue493: kill mid devices revoke → relaunch → Devices view matches the server", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE, keepVaultA: true });
  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    /* Revoke device B from A's real Devices view (admin-token gated). */
    await openDevicesView(pair.A);
    const bRow = pair.A.win.locator('[data-testid="geode-device-row"]', { hasText: "device-B" });
    await bRow.locator('[data-testid="geode-device-revoke"]').click();
    await pair.A.win.locator('[data-testid="geode-admin-token-input"]').fill("e2e");
    await pair.A.win.locator('[data-testid="geode-admin-token-continue"]').click();
    await expect(pair.A.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await pair.A.win.locator('[data-testid="geode-confirm-yes"]').click();

    /* Deterministic mid-revoke signal: B's server row is gone. */
    await waitForServerState(
      () => serverDeviceCount(pair.server.dataDir, pair.server.vaultId),
      (n) => n === 1,
      30_000,
      "revoked device row gone from the server",
    );

    const a2 = await relaunchDesktop(pair.A);
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* Server and UI agree: only A's row remains. */
      await openDevicesView(a2);
      const rows = a2.win.locator('[data-testid="geode-device-row"]');
      await expect(rows).toHaveCount(1, { timeout: 15_000 });
      expect(await rows.first().locator(".geode-device-name").textContent()).toContain(
        "(this device)",
      );
      await a2.win.locator('[data-testid="geode-devices-modal"]').screenshot({
        path: shotPath("493-devices-revoke-settled.png"),
      });
    } finally {
      await a2.close();
    }
  } finally {
    /* hardKill made A.close() a no-op for the dirs: remove them explicitly. */
    await pair.stop();
    await rm(pair.A.vaultDir, { recursive: true, force: true });
    await rm(pair.A.userDataDir, { recursive: true, force: true });
  }
});
