import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #64: "Leave Geode vault" returns the tab to the unconfigured state.

const PASSPHRASE = "leave-vault-pass";

test("leave confirmed vault → unconfigured state, no errors", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("leave-vault");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    /* Wait for synced baseline. */
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* ---- Step 1: Open settings tab + Geode tab, expand Advanced (recovery) ---- */
    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    /* Expand the Advanced section by clicking the heading. */
    await obsidian.win.locator(".geode-advanced-heading").click();

    /* ---- Step 2: Assert "Leave Geode vault" button is visible ---- */
    const leaveBtn = obsidian.win.locator('[data-testid="geode-settings-leave"]');
    await expect(leaveBtn).toBeVisible({ timeout: 10_000 });

    /* Screenshot the settings tab with the leave button visible. */
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("leave-vault-settings.png"),
    })
      .catch(async () => {
        await obsidian.win.screenshot({ path: shotPath("leave-vault-settings.png") });
      });

    /* ---- Step 3: Click "Leave Geode vault" → confirm modal ---- */
    await leaveBtn.click();

    /* Wait for the confirm modal to appear. */
    const confirmModal = obsidian.win.locator(".geode-confirm-modal");
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });

    /* Assert the warning text is present. */
    const modalText = await confirmModal.locator("p").textContent();
    expect(modalText).toContain("clears its local sync state");

    /* Screenshot the confirm modal. */
    await obsidian.win.locator(".modal-container").last().screenshot({
      path: shotPath("leave-vault-confirm.png"),
    })
      .catch(async () => {
        await obsidian.win.screenshot({ path: shotPath("leave-vault-confirm.png") });
      });

    /* ---- Step 4: Click confirm (geode-confirm-yes) ---- */
    await obsidian.win.locator('[data-testid="geode-confirm-yes"]').click();

    /* ---- Step 5: Assert the tab re-rendered to UNCONFIGURED state ---- */
    /* The "Run setup wizard" button must be visible. */
    const runWizardBtn = obsidian.win.locator('[data-testid="geode-settings-run-wizard"]');
    await expect(runWizardBtn).toBeVisible({ timeout: 15_000 });

    /* The "Leave Geode vault" button must be gone. */
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-leave"]'),
    ).toHaveCount(0);

    /* ---- Step 6: Assert the log ring has no [error] lines after the leave ---- */
    const errorCount = await obsidian.eval<number>(`
      const entries = app.plugins.plugins.geode.getRecentLog();
      return entries.filter((e) => e.level === "error").length;
    `);
    expect(errorCount, `expected no log errors after leave, found ${errorCount}`).toBe(0);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
