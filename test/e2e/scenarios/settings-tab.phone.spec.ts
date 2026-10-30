import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #29: on-device: the settings tab's buttons, toggles and auto-lock.

const PASSPHRASE = "settings-tab-pass";

test("settings tab: buttons, toggles, auto-lock, advanced section, lock/unlock, reconcile/push", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("settings");

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

    /* Wait for synced baseline so the sync loop isn't racing us. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any stacked modals before opening settings. */
    await dismissModals(obsidian);

    /* ---- Step 1: Open settings tab, assert Vault status = "Unlocked" ---- */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    const vaultStatusRow = obsidian.win.locator('[data-testid="geode-settings-vault-status"]');
    await expect.poll(
      async () => (await vaultStatusRow.locator(".setting-item-description").textContent())?.trim(),
      { timeout: 10_000 },
    ).toBe("Unlocked. Locking requires the passphrase to sync again.");

    /* ---- Step 1.5: sections render in order; Advanced collapsed by default (#134) ---- */
    const sectionHeadings = await obsidian.win
      .locator(".geode-section .setting-item-heading")
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

    /* On-device persistence (#134): the clean pass wrote last_backup_at into sync-cursor.json. */
    await expect.poll(
      async () =>
        await obsidian.eval<number>(`
          const dir = app.plugins.plugins.geode.manifest.dir;
          try {
            return JSON.parse(await app.vault.adapter.read(dir + "/sync-cursor.json")).last_backup_at ?? 0;
          } catch (_e) { return 0; }
        `),
      { timeout: 90_000 },
    ).toBeGreaterThan(0);
    await obsidian.screenshot(shotPath("134-phone-01-unlocked.png"));

    /* ---- Step 2: Assert presence of buttons ---- */
    await expect(obsidian.win.locator('[data-testid="geode-settings-lock"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-reconcile"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-push"]')).toBeVisible();

    /* Resync + Debug logging live inside the collapsed Advanced section: expand it first. */
    await evalClick(obsidian, ".geode-advanced-heading");
    await expect(obsidian.win.locator('[data-testid="geode-settings-resync"]')).toBeVisible();

    /* ---- Step 3: Toggle Debug logging ---- */

    const originalDebugLogging = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );

    /* Flip it */
    await evalClick(obsidian, '[data-testid="geode-settings-toggle-debug"]');
    const flippedDebug = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );
    expect(flippedDebug).not.toBe(originalDebugLogging);

    /* Flip back */
    await evalClick(obsidian, '[data-testid="geode-settings-toggle-debug"]');
    const restoredDebug = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.debugLogging",
    );
    expect(restoredDebug).toBe(originalDebugLogging);

    /* Collapse Advanced again: the next steps drive the open sections only. */
    await evalClick(obsidian, ".geode-advanced-heading");

    /* ---- Step 4: Toggle Sync .obsidian/ config ---- */

    const originalSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );

    await evalClick(obsidian, '[data-testid="geode-settings-toggle-sync-obsidian"]');
    const flippedSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );
    expect(flippedSyncObs).not.toBe(originalSyncObs);

    await evalClick(obsidian, '[data-testid="geode-settings-toggle-sync-obsidian"]');
    const restoredSyncObs = await obsidian.eval<boolean>(
      "app.plugins.plugins.geode.pluginSettings.syncObsidianConfig",
    );
    expect(restoredSyncObs).toBe(originalSyncObs);

    /* ---- Step 5: Change Auto-lock after (hours) ---- */

    const originalAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );

    const newAutoLockValue = originalAutoLock === 24 ? 48 : 24;
    await evalSetValue(
      obsidian,
      '[data-testid="geode-settings-autolock"]',
      String(newAutoLockValue),
    );

    const updatedAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );
    expect(updatedAutoLock).toBe(newAutoLockValue);

    /* Restore original */
    await evalSetValue(
      obsidian,
      '[data-testid="geode-settings-autolock"]',
      String(originalAutoLock),
    );

    const restoredAutoLock = await obsidian.eval<number>(
      "app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours",
    );
    expect(restoredAutoLock).toBe(originalAutoLock);

    /* ---- Step 6: Advanced section: collapsed → expanded → collapsed ---- */
    /* Collapsed container has display:none, so assert existence, not visibility. */
    await expect(obsidian.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);

    await evalClick(obsidian, ".geode-advanced-heading");

    /* After click, geode-collapsed class should be removed */
    await expect(obsidian.win.locator(".geode-advanced-fields:not(.geode-collapsed)")).toHaveCount(
      1,
    );

    /* Server address input should be visible inside expanded fields */
    await expect(obsidian.win.locator('[data-testid="geode-settings-adv-server"]')).toBeVisible();

    /* Collapse again */
    await evalClick(obsidian, ".geode-advanced-heading");
    await expect(obsidian.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);

    /* ---- Step 7: Click "Lock vault" → locked layout updates in place (#458, no re-render) ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-lock"]');

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
    await obsidian.eval(
      `document.querySelector('.vertical-tab-content-container')?.scrollTo(0, 0); return true;`,
    );
    await obsidian.screenshot(shotPath("134-phone-02-locked.png"));

    /* Status bar should show locked */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 15_000 },
    ).toBe("Geode: locked");

    /* ---- Step 8: Click "Unlock" → passphrase modal → type passphrase → click Unlock → unlocked ---- */
    /* NB: don't dismissModals here: the settings tab is itself a .modal-container, so it would
       close the tab and drop the unlock button. The button is already asserted visible above. */
    await evalClick(obsidian, '[data-testid="geode-settings-unlock"]');

    /* Wait for passphrase modal to appear */
    const passphraseModal = obsidian.win.locator(".modal:has(:text('Unlock Geode'))").last();
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });

    /* Type passphrase and click Unlock */
    const passwordInput = passphraseModal.locator('[data-testid="geode-passphrase-input"]');
    await expect(passwordInput).toBeVisible();
    await evalSetValue(obsidian, '[data-testid="geode-passphrase-input"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');

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
    await evalClick(obsidian, '[data-testid="geode-settings-reconcile"]');
    await new Promise((r) => setTimeout(r, 2_000));

    const errorNoticesAfterReconcile = await obsidian.win.locator(
      '.notice:has-text("Error"), .notice:has-text("failed")',
    ).count();
    expect(errorNoticesAfterReconcile).toBe(0);

    await evalClick(obsidian, '[data-testid="geode-settings-push"]');
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
