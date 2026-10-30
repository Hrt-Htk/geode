import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #29: the settings tab's buttons, toggles, auto-lock and advanced rows.

const PASSPHRASE = "settings-tab-pass";

/**
 * Helper: dismiss any lingering modals (startup modal, passphrase modal, etc.)
 * Copied from statusbar-driven-states.spec.ts: keepStartupModal leaves stacked modals.
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

test("settings tab: buttons, toggles, auto-lock, advanced section, lock/unlock, reconcile/push", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("settings");

  const obsidian = await launchObsidian({
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

    /* Wait for synced baseline so the sync loop isn't racing us. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any stacked modals before opening settings. */
    await dismissAllModals(obsidian.win);

    /* ---- Step 1: Open settings tab, assert Vault status = "Unlocked" ---- */
    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    const vaultStatusRow = obsidian.win.locator('[data-testid="geode-settings-vault-status"]');
    await expect.poll(
      async () => await vaultStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toBe("Unlocked. Locking requires the passphrase to sync again.");

    /* ---- Step 1.5: sections render in order; Advanced collapsed by default (#134) ---- */
    const sectionHeadings = await obsidian.win
      .locator(".vertical-tab-content .geode-section .setting-item-heading")
      .allTextContents();
    const expectedSections = ["Status", "Vault", "Devices", "Sync scope", "Trash", "Advanced"];
    for (let i = 0; i < expectedSections.length; i++) {
      expect(sectionHeadings[i], `section #${i} heading`).toContain(expectedSections[i]);
    }
    await expect(obsidian.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);
    await expect(obsidian.win.locator(".geode-section-fields:not(.geode-collapsed)")).toHaveCount(
      5,
    );

    /* Sync status row: "Up to date. Last backup …" + green dot once a clean sync pass lands. */
    const syncStatusRow = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 30_000 },
    ).toMatch(/^Up to date\. Last backup (just now|\d+ min ago)\.$/);
    await expect(syncStatusRow.locator(".geode-sync-dot-green")).toBeVisible();

    /* Trash count row: settled count, not stuck on "Checking trash…". */
    const trashCountRow = obsidian.win.locator('[data-testid="geode-settings-trash-count"]');
    await expect.poll(
      async () => await trashCountRow.locator(".setting-item-description").textContent(),
      { timeout: 15_000 },
    ).toMatch(/^(Trash is empty|1 file in trash|\d+ files in trash)$/);

    /* Sync activity row + View button (Notice placeholder). */
    await expect(obsidian.win.locator('[data-testid="geode-settings-activity"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-activity-view"]'))
      .toBeVisible();

    /* ---- Step 2: Assert presence of buttons ---- */
    await expect(obsidian.win.locator('[data-testid="geode-settings-lock"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-reconcile"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-push"]')).toBeVisible();

    /* Resync + Debug logging live inside the collapsed Advanced section: expand it first. */
    await obsidian.win.locator(".geode-advanced-heading").click();
    await expect(obsidian.win.locator('[data-testid="geode-settings-resync"]')).toBeVisible();

    /* #233: pairing-code "Add a device" button is retired: must be absent. */
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-add-device"]'),
    ).toHaveCount(0);

    /* Durable UI gate: screenshot the Geode settings pane for visual review. */
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("settings-no-add-device.png"),
    })
      .catch(async () => {
        await obsidian.win.screenshot({ path: shotPath("settings-no-add-device.png") });
      });

    /* ---- Step 3: Toggle Debug logging ---- */
    const debugToggle = obsidian.win.locator('[data-testid="geode-settings-toggle-debug"]');

    const originalDebugLogging = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );

    /* Flip it */
    await debugToggle.click();
    const flippedDebug = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );
    expect(flippedDebug).not.toBe(originalDebugLogging);

    /* Flip back */
    await debugToggle.click();
    const restoredDebug = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );
    expect(restoredDebug).toBe(originalDebugLogging);

    /* Collapse Advanced again: the next steps drive the open sections only. */
    await obsidian.win.locator(".geode-advanced-heading").click();

    /* ---- Step 4: Toggle Sync .obsidian/ config ---- */
    const syncObsToggle = obsidian.win.locator(
      '[data-testid="geode-settings-toggle-sync-obsidian"]',
    );

    const originalSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );

    await syncObsToggle.click();
    const flippedSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );
    expect(flippedSyncObs).not.toBe(originalSyncObs);

    await syncObsToggle.click();
    const restoredSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );
    expect(restoredSyncObs).toBe(originalSyncObs);

    /* ---- Step 5: Change Auto-lock after (hours) ---- */
    const autoLockInput = obsidian.win.locator('[data-testid="geode-settings-autolock"]');

    const originalAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );

    const newAutoLockValue = originalAutoLock === 24 ? 48 : 24;
    await autoLockInput.clear();
    await autoLockInput.fill(String(newAutoLockValue));
    await autoLockInput.press("Enter");

    const updatedAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );
    expect(updatedAutoLock).toBe(newAutoLockValue);

    /* Restore original */
    await autoLockInput.clear();
    await autoLockInput.fill(String(originalAutoLock));
    await autoLockInput.press("Enter");

    const restoredAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );
    expect(restoredAutoLock).toBe(originalAutoLock);

    /* ---- Step 6: Advanced section: collapsed → expanded → collapsed ---- */
    /* Collapsed container has display:none, so assert existence, not visibility. */
    await expect(obsidian.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);

    const advancedHeading = obsidian.win.locator(".geode-advanced-heading");
    await advancedHeading.click();

    /* After click, geode-collapsed class should be removed */
    await expect(obsidian.win.locator(".geode-advanced-fields:not(.geode-collapsed)")).toHaveCount(
      1,
    );

    /* Server address input should be visible inside expanded fields */
    await expect(obsidian.win.locator('[data-testid="geode-settings-adv-server"]')).toBeVisible();

    /* Collapse again */
    await advancedHeading.click();
    await expect(obsidian.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);

    /* ---- Step 7: Click "Lock vault" → locked layout updates in place (#458, no re-render) ---- */
    await obsidian.win.locator('[data-testid="geode-settings-lock"]').click();

    /* Locked: Status keeps only the sync-status row + [Unlock]; Vault keeps only the
       read-only vault-name row; every other section + row hides. */
    await expect(obsidian.win.locator('[data-testid="geode-settings-unlock"]')).toBeVisible();
    const lockedSyncStatus = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect.poll(
      async () => await lockedSyncStatus.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-vault-name"] .setting-item-description'),
    ).toHaveText(/· 127\.0\.0\.1:\d+$/);
    await expect(obsidian.win.locator('[data-testid="geode-settings-vault-status"]')).toHaveClass(
      /geode-hidden/,
    );
    await expect(obsidian.win.locator('[data-testid="geode-settings-vault-rename"]')).toHaveCount(
      0,
    );
    await expect(obsidian.win.locator('[data-testid="geode-settings-storage"]')).toHaveClass(
      /geode-hidden/,
    );
    await expect(obsidian.win.locator('[data-testid="geode-settings-activity"]')).toHaveClass(
      /geode-hidden/,
    );
    /* reconcile/push/autolock testids sit on the control (button/input): the row hides it. */
    await expect(obsidian.win.locator('[data-testid="geode-settings-reconcile"]')).not
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-push"]')).not.toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-autolock"]')).not.toBeVisible();
    for (const name of ["Devices", "Sync scope", "Trash", "Advanced"]) {
      await expect(
        obsidian.win.locator(`.geode-section:has(.setting-item-heading:has-text('${name}'))`),
      ).toHaveClass(/geode-hidden/);
    }

    /* Status bar should show locked */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 15_000 },
    ).toBe("Geode: locked");

    /* ---- Step 8: Click "Unlock" → passphrase modal → type passphrase → Enter → unlocked ---- */
    await obsidian.win.locator('[data-testid="geode-settings-unlock"]').click();

    /* Wait for passphrase modal to appear */
    const passphraseModal = obsidian.win.locator(".modal:has(:text('Unlock Geode'))");
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });

    /* Type passphrase and press Enter */
    const passwordInput = passphraseModal.locator('[data-testid="geode-passphrase-input"]');
    await expect(passwordInput).toBeVisible();
    await passwordInput.fill(PASSPHRASE);
    await passwordInput.press("Enter");

    /* Wait for modal to close */
    await expect(passphraseModal).not.toBeVisible({ timeout: 15_000 });

    /* Unlock updates rows in place (no display() re-run): hidden rows/sections return. */

    const unlockedAfterRow = obsidian.win.locator('[data-testid="geode-settings-vault-status"]');
    await expect.poll(
      async () => await unlockedAfterRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toBe("Unlocked. Locking requires the passphrase to sync again.");
    await expect(obsidian.win.locator('[data-testid="geode-settings-vault-rename"]')).toBeVisible();
    for (const name of ["Devices", "Sync scope", "Trash", "Advanced"]) {
      await expect(
        obsidian.win.locator(`.geode-section:has(.setting-item-heading:has-text('${name}'))`),
      ).not.toHaveClass(/geode-hidden/);
    }

    /* ---- Step 9: Click "Reconcile now" and "Push now": no error notice ---- */
    await obsidian.win.locator('[data-testid="geode-settings-reconcile"]').click();
    await new Promise((r) => setTimeout(r, 2_000));

    const errorNoticesAfterReconcile = await obsidian.win.locator(
      '.notice:has-text("Error"), .notice:has-text("failed")',
    ).count();
    expect(errorNoticesAfterReconcile).toBe(0);

    await obsidian.win.locator('[data-testid="geode-settings-push"]').click();
    await new Promise((r) => setTimeout(r, 2_000));

    const errorNoticesAfterPush = await obsidian.win.locator(
      '.notice:has-text("Error"), .notice:has-text("failed")',
    ).count();
    expect(errorNoticesAfterPush).toBe(0);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
