import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #64: on-device: leave, then the vault's local state files are gone.

const PASSPHRASE = "leave-vault-pass";

test("leave confirmed vault → unconfigured state, no errors (on-device)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("leave-vault-phone");

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
    /* connectPhone starts locked (mirrors desktop default): unlock via the real
       unlockVault path before waiting for the synced baseline. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any stacked modals before opening settings. */
    await dismissModals(obsidian);

    /* ---- Step 1: Open settings tab + Geode tab, expand Advanced ---- */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return "ok";
    `);

    /* Expand the Advanced section. */
    await evalClick(obsidian, ".geode-advanced-heading");

    /* ---- Step 2: Assert "Leave Geode vault" button is present ---- */
    const leavePresent = await obsidian.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-leave"]')`,
    );
    expect(leavePresent).toBe(true);

    /* ---- Step 3: Click "Leave Geode vault" → confirm modal ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-leave"]');

    /* Wait for the confirm modal to appear. */
    await expect(
      obsidian.win.locator(".geode-confirm-modal"),
    ).toBeVisible({ timeout: 10_000 });

    /* ---- Step 4: Take a screenshot (clear notices first to avoid overlay). ---- */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
    `);
    await obsidian.screenshot(shotPath("leave-vault-confirm-phone.png"));

    /* Assert the warning text is present. */
    const modalText = await obsidian.eval<string>(
      `document.querySelector(".geode-confirm-modal p")?.textContent ?? ""`,
    );
    expect(modalText).toContain("clears its local sync state");

    /* ---- Step 5: Click confirm (geode-confirm-yes) ---- */
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');

    /* ---- Step 6: Assert the tab re-rendered to UNCONFIGURED state ---- */
    /* leaveVault() is async (clears cache + state files, saves, re-renders), so poll
       for the unconfigured tab rather than reading the DOM synchronously. */
    await obsidian.win.waitForFunction(
      () => !!document.querySelector('[data-testid="geode-settings-run-wizard"]'),
      undefined,
      { timeout: 15_000 },
    );
    const runWizardPresent = await obsidian.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-run-wizard"]')`,
    );
    expect(runWizardPresent).toBe(true);

    const leaveGone = await obsidian.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-leave"]')`,
    );
    expect(leaveGone).toBe(false);

    /* ---- Step 7: Take another screenshot of the unconfigured state ---- */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
    `);
    await obsidian.screenshot(shotPath("leave-vault-unconfigured-phone.png"));

    /* ---- Step 8: Assert on-device state files are gone ---- */
    const localFilesExists = await obsidian.eval<boolean>(
      `(() => {
        const geode = app.plugins.plugins.geode;
        const dir = geode?.manifest?.dir ?? (app.vault.configDir + "/plugins/geode");
        return app.vault.adapter.exists(dir + "/local-files.json");
      })()`,
    );
    expect(localFilesExists, "local-files.json should be removed after leave").toBe(false);

    /* ---- Step 9: Assert the log ring has no [error] lines after the leave ---- */
    const errorCount = await obsidian.eval<number>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error").length`,
    );
    expect(errorCount, `expected no log errors after leave, found ${errorCount}`).toBe(0);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
