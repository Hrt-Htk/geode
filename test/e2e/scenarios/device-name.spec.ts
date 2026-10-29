import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "device-name-passphrase";
const BLANK_CREDS = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };
const SHOT_WIZARD = "create-wizard.png";
const SHOT_PANEL = "device-panel.png";
const SHOT_RENAME_MODAL = "rename-modal.png";

// #66: the create wizard pre-fills a "Device name" field, and the settings
// device panel marks the current device's row with "(this device)".
test("create wizard shows pre-filled device name", async () => {
  test.slow();

  const server = await startServer();
  const obsidian = await launchObsidian({
    geodeSettings: BLANK_CREDS,
    keepStartupModal: true,
  });

  try {
    await waitForPluginLoaded(obsidian);
    // First-run Obsidian auto-opens its own Settings modal over the wizard;
    // focusSetupWizard closes it and waits for the "Set up Geode" modal.
    await focusSetupWizard(obsidian);

    await obsidian.win
      .locator('[data-testid="geode-wizard-create"]')
      .click();

    // Redesigned wizard (#459): the vault step (with the device name) comes
    // after the server step's Continue, which checks the server first.
    await obsidian.win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await obsidian.win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await obsidian.win.locator('[data-testid="geode-create-continue"]').click();

    const deviceNameInput = obsidian.win.locator('[data-testid="geode-create-device-name"]');
    await expect(deviceNameInput).toBeVisible();

    const deviceName = await deviceNameInput.inputValue();
    const modalText = await obsidian.win.locator(".modal").first().innerText();
    console.log("=== CREATE WIZARD DEVICE NAME ===");
    console.log("value:", JSON.stringify(deviceName));
    console.log("modal text:\n" + modalText);
    console.log("=== END ===");

    expect(deviceName, "device name should be pre-filled with Desktop <Noun>").toMatch(
      /^Desktop \w+$/,
    );

    await obsidian.win.locator(".modal-container").first().screenshot({
      path: shotPath(SHOT_WIZARD),
    });
    console.log("SCREENSHOT:", SHOT_WIZARD);
  } finally {
    await obsidian.close();
    await server.stop();
  }
});

test("devices view marks current device with (this device)", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("device-panel");
  // A second device so the current-device accent has a plain row to contrast against.
  await server.mintToken("other-desktop");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(obsidian);

    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);

    // #433/#447: the settings Devices section is a summary row + [Manage]; the
    // device rows live in the Devices view, readable with the device token.
    await obsidian.win.locator('[data-testid="geode-settings-devices-manage"]').click();
    const modal = obsidian.win.locator('[data-testid="geode-devices-modal"]');
    await expect(modal).toBeVisible();

    const rows = modal.locator('[data-testid="geode-device-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    const rowNames = await rows.locator(".geode-device-name").allTextContents();
    console.log("=== DEVICES VIEW ROWS ===");
    for (const name of rowNames) console.log(name);
    console.log("=== END ===");

    expect(rowNames.some((n) => n.includes("(this device)"))).toBe(
      true,
      "current device row should be marked (this device)",
    );

    // #330: rename the current device via the Devices view.
    const NEW_NAME = "E2E-Renamed-Device";
    const currentRow = rows.filter({ hasText: "(this device)" });
    await currentRow.locator('[data-testid="geode-device-rename"]').click();

    const renameInput = obsidian.win.locator('[data-testid="geode-device-rename-input"]');
    await expect(renameInput).toBeVisible();
    await renameInput.fill(NEW_NAME);
    await obsidian.win.locator(".modal-container").first().screenshot({
      path: shotPath(SHOT_RENAME_MODAL),
    });
    console.log("SCREENSHOT:", SHOT_RENAME_MODAL);
    await obsidian.win.locator('[data-testid="geode-device-rename-confirm"]').click();

    // The rename lands on the server, then the view refreshes the row in place.
    await expect
      .poll(
        async () =>
          (await modal.locator(".geode-device-name").allTextContents()).some((n) =>
            n.includes(NEW_NAME)
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    await modal.screenshot({ path: shotPath(SHOT_PANEL) });
    console.log("SCREENSHOT:", SHOT_PANEL);
  } finally {
    await obsidian.close();
    await server.stop();
  }
});
