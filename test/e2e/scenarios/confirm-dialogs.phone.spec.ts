import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #460: the Leave confirm dialog on-device: it names the vault, and Cancel
// keeps the vault configured. (Phone counterpart of confirm-dialogs.spec.ts.)
const PASSPHRASE = "confirm-dialogs-pass";
const VAULT_NAME = "Gate 460 Vault";

test("confirms: leave confirm names the vault, cancel keeps configured (on-device)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("confirm-dialogs-phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
  });

  try {
    /* connectPhone starts locked: unlock via the real unlockVault path. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Name the vault so the Leave dialog can name it. */
    await obsidian.eval(
      `app.plugins.plugins.geode.onVaultNameResolved(${JSON.stringify(VAULT_NAME)}); return true;`,
    );

    await dismissModals(obsidian);

    /* Open settings tab + Geode tab, expand Advanced. */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return "ok";
    `);
    await evalClick(obsidian, ".geode-advanced-heading");

    /* ---- Open the Leave confirm dialog ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-leave"]');
    await expect(
      obsidian.win.locator(".geode-confirm-modal"),
    ).toBeVisible({ timeout: 10_000 });

    /* The dialog names the vault and carries the consequence line. */
    const spec = await obsidian.eval<{ title: string; message: string }>(`
      (() => {
        const c = document.querySelector(".geode-confirm-modal");
        return {
          title: c?.closest(".modal-container")?.querySelector(".modal-title")?.textContent ?? "",
          message: c?.querySelector("p")?.textContent ?? "",
        };
      })()
    `);
    expect(spec.title).toBe(`Leave ${VAULT_NAME}?`);
    expect(spec.message).toBe(
      "Disconnects this device and clears its local sync state. Your notes stay.",
    );

    /* Screenshot on-device (adb screencap). */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
    `);
    await obsidian.screenshot(shotPath("460-phone-01.png"));

    /* ---- Cancel: dialog closes, vault stays configured ---- */
    await evalClick(obsidian, '[data-testid="geode-confirm-cancel"]');
    await expect(
      obsidian.win.locator(".geode-confirm-modal"),
    ).not.toBeVisible({ timeout: 10_000 });

    const stillConfigured = await obsidian.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-leave"]')`,
    );
    expect(stillConfigured).toBe(true);
    const unconfigured = await obsidian.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-run-wizard"]')`,
    );
    expect(unconfigured).toBe(false);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
