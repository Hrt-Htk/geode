import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import {
  AUTO_LOCK_ROW,
  closeSettingsPage,
  DEBUG_LOGGING_ROW,
  openSettingsPage,
  rowShown,
  setRowControl,
  shownSections,
  SYNC_CONFIG_ROW,
} from "../helpers/settings-tab";

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

    /* ---- Step 1.5: sections render in order; Advanced is a sub-page (#16) ---- */
    expect(await shownSections(obsidian)).toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced"],
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

    /* Resync + Debug logging live on the Advanced page: open it first. */
    await openSettingsPage(obsidian, "Advanced");
    await expect(obsidian.win.locator('[data-testid="geode-settings-resync"]')).toBeVisible();

    /* ---- Step 3: Toggle Debug logging ---- */
    const readSetting = <T>(key: string) =>
      obsidian.eval<T>(`app.plugins.plugins.geode.pluginSettings.${key}`);
    const originalDebugLogging = await readSetting<boolean>("debugLogging");
    await setRowControl(obsidian, DEBUG_LOGGING_ROW);
    await expect.poll(() => readSetting<boolean>("debugLogging")).toBe(!originalDebugLogging);
    await setRowControl(obsidian, DEBUG_LOGGING_ROW);
    await expect.poll(() => readSetting<boolean>("debugLogging")).toBe(originalDebugLogging);

    /* Back to the tab: the next steps drive its groups. */
    await closeSettingsPage(obsidian);

    /* ---- Step 4: Toggle Sync config folder ---- */
    const originalSyncObs = await readSetting<boolean>("syncObsidianConfig");
    await setRowControl(obsidian, SYNC_CONFIG_ROW);
    await expect.poll(() => readSetting<boolean>("syncObsidianConfig")).toBe(!originalSyncObs);
    await setRowControl(obsidian, SYNC_CONFIG_ROW);
    await expect.poll(() => readSetting<boolean>("syncObsidianConfig")).toBe(originalSyncObs);

    /* ---- Step 5: Change Auto lock after (hours) ---- */
    const originalAutoLock = await readSetting<number>("unlockTimeoutHours");
    const newAutoLockValue = originalAutoLock === 24 ? 48 : 24;
    await setRowControl(obsidian, AUTO_LOCK_ROW, String(newAutoLockValue));
    await expect.poll(() => readSetting<number>("unlockTimeoutHours")).toBe(newAutoLockValue);
    await setRowControl(obsidian, AUTO_LOCK_ROW, String(originalAutoLock));
    await expect.poll(() => readSetting<number>("unlockTimeoutHours")).toBe(originalAutoLock);

    /* ---- Step 6: the Advanced page opens and closes ---- */
    await openSettingsPage(obsidian, "Advanced");
    await expect(obsidian.win.locator('[data-testid="geode-settings-adv-server"]')).toBeVisible();
    await closeSettingsPage(obsidian);
    await expect.poll(() => rowShown(obsidian, "Server address")).toBe(false);

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
    await expect(obsidian.win.locator('[data-testid="geode-settings-vault-status"]')).toBeHidden();
    await expect(obsidian.win.locator('[data-testid="geode-settings-vault-rename"]')).toHaveCount(
      0,
    );
    await expect(obsidian.win.locator('[data-testid="geode-settings-storage"]')).toBeHidden();
    await expect(obsidian.win.locator('[data-testid="geode-settings-activity"]')).toBeHidden();
    await expect(obsidian.win.locator('[data-testid="geode-settings-reconcile"]')).not
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-push"]')).not.toBeVisible();
    expect(await rowShown(obsidian, AUTO_LOCK_ROW)).toBe(false);
    expect(await shownSections(obsidian), "only Vault shows while locked").toEqual(["Vault"]);
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
    await expect.poll(() => shownSections(obsidian)).toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced"],
    );

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
