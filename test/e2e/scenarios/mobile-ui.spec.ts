import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #173: desktop: the mobile UI's Logs section and settings-button feedback.

const PASSPHRASE = "mobile-ui-pass";

/**
 * Helper: dismiss any lingering modals (startup modal, passphrase modal, etc.)
 * Copied from settings-tab.spec.ts: keepStartupModal leaves stacked modals.
 */
async function dismissAllModals(win: Page) {
  for (let i = 0; i < 5; i++) {
    const count = await win.locator(".modal-container").count();
    if (count === 0) break;
    const closeBtn = win.locator(".modal-close-button").last();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
    } else {
      await win.keyboard.press("Escape");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("mobile UI: Logs section and settings button feedback", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("mobile-ui");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
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

    /* Wait for synced baseline so the sync loop isn't racing us. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any stacked modals before interacting. */
    await dismissAllModals(obsidian.win);

    /* ---- Screenshot 1: Logs section in the settings tab (Debug logging on) ---- */
    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const logs = sections.find((s) =>
        s.querySelector(".setting-item-heading")?.textContent?.trim() === "Logs");
      if (logs) logs.querySelector(".geode-collapsible-heading")?.click();
      return true;
    `);

    /* Give the section a moment to render. */
    await new Promise((r) => setTimeout(r, 1_500));

    /* Assert the Logs section and its log box exist. */
    const logsSection = obsidian.win.locator(
      '.geode-section:has(.setting-item-heading:has-text("Logs"))',
    );
    await expect(logsSection).toHaveCount(1, { timeout: 10_000 });
    await expect(obsidian.win.locator('[data-testid="geode-log-box"]')).toBeVisible({
      timeout: 10_000,
    });

    /* Screenshot: the Logs section scrolled into view. */
    await obsidian.eval(`
      document.querySelectorAll('.notice').forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    const debugPng = shotPath("debug-pane.png");
    await obsidian.win.locator(".vertical-tab-content").screenshot({ path: debugPng }).catch(
      async () => {
        await obsidian.win.screenshot({ path: debugPng });
      },
    );

    /* ---- Screenshot 2: Settings buttons with success Notice feedback ---- */
    /* Open settings tab (already open: re-open cleanly on desktop). */
    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    /* Assert the two Status-section action buttons are visible, then expand Advanced
       (Resync now lives in the collapsed Advanced section). */
    await expect(obsidian.win.locator('[data-testid="geode-settings-reconcile"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(obsidian.win.locator('[data-testid="geode-settings-push"]')).toBeVisible();
    await obsidian.win.locator(".geode-advanced-heading").click();
    await expect(obsidian.win.locator('[data-testid="geode-settings-resync"]')).toBeVisible();

    /* Click "Reconcile now" and wait for success Notice. */
    await obsidian.win.locator('[data-testid="geode-settings-reconcile"]').click();

    /* Wait for a success Notice containing "complete" to appear. */
    const successNotice = obsidian.win.locator('.notice:has-text("complete")');
    await expect(successNotice).toBeVisible({ timeout: 5_000 });

    /* Assert no error Notice is present. */
    const errorNotices = await obsidian.win.locator(
      '.notice:has-text("failed"), .notice:has-text("Error")',
    ).count();
    expect(errorNotices).toBe(0);

    /* Brief pause so the Notice is clearly visible in the screenshot. */
    await new Promise((r) => setTimeout(r, 500));

    /* Screenshot full window to capture Notice toast + settings buttons. */
    const settingsPng = shotPath("settings-buttons.png");
    await obsidian.win.screenshot({ path: settingsPng });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
