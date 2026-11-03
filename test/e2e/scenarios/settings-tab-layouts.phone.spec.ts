import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import {
  AUTO_LOCK_ROW,
  openSettingsPage,
  rowInventory,
  rowShown,
  shownSections,
} from "../helpers/settings-tab";

// #458 on-device: locked layout (status + vault-name rows only) + unlock restores in
// place + leave → not-set-up layout. Screenshot via adb (screencap).
const PASSPHRASE = "settings-tab-layouts-pass";

const HIDDEN_WHEN_LOCKED = [
  "geode-settings-storage",
  "geode-settings-reconcile",
  "geode-settings-push",
  "geode-settings-activity",
  "geode-settings-vault-status",
];

/* reconcile/push testids sit on the control (button): the row's display hides it. */
const isHidden = `
  (id) => {
    const el = document.querySelector('[data-testid="' + id + '"]');
    return !!el && el.offsetParent === null;
  }
`;

const UNLOCKED_SECTIONS = ["Vault", "Devices", "Sync scope", "Trash", "Advanced"];

test("tab states (phone): locked rows-only layout, unlock in place, leave → not set up", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("settings-tab-layouts-phone");

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
    /* connectPhone starts locked: unlock via the real path, then wait for the baseline. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* Open the settings tab (no leading close on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return "ok";
    `);
    await obsidian.win.locator('[data-testid="geode-settings-sync-status"]').waitFor({
      timeout: 15_000,
    });
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-storage"]'),
    ).toBeVisible();

    /* ---- Lock: only status + vault-name rows remain ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-lock"]');
    await expect.poll(
      async () =>
        await obsidian.win
          .locator('[data-testid="geode-settings-sync-status"] .setting-item-description')
          .textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
    expect((await rowInventory(obsidian)).length).toBe(3); // status + forgot link + vault-name
    const lockedHiddenRows = await obsidian.eval<boolean>(`
      ${JSON.stringify(HIDDEN_WHEN_LOCKED)}.every(${isHidden})
    `);
    expect(lockedHiddenRows, "storage/actions/vault-lock/autolock rows hidden while locked").toBe(
      true,
    );
    expect(await rowShown(obsidian, AUTO_LOCK_ROW)).toBe(false);
    expect(await shownSections(obsidian), "only Vault shows while locked").toEqual(["Vault"]);
    const renameGone = await obsidian.eval<boolean>(
      `!document.querySelector('[data-testid="geode-settings-vault-rename"]')`,
    );
    expect(renameGone, "no Rename while locked").toBe(true);

    /* adb screenshot of the locked layout. */
    await obsidian.screenshot(shotPath("458-phone-01-locked.png"));

    /* ---- Unlock: hidden rows/sections return in place ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-unlock"]');
    const unlockModal = obsidian.win.locator('.modal:has(:text("Unlock Geode"))').last();
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await evalSetValue(obsidian, '[data-testid="geode-passphrase-input"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');
    await expect(unlockModal).not.toBeVisible({ timeout: 15_000 });
    await expect.poll(
      async () =>
        await obsidian.win
          .locator('[data-testid="geode-settings-vault-status"] .setting-item-description')
          .textContent(),
      { timeout: 15_000 },
    ).toMatch(/^Unlocked\. /);
    await expect.poll(() => shownSections(obsidian), { message: "sections restored on unlock" })
      .toEqual(UNLOCKED_SECTIONS);
    expect(
      await obsidian.eval<boolean>(
        `!!document.querySelector('[data-testid="geode-settings-vault-rename"]')`,
      ),
    ).toBe(true);

    /* ---- Leave → not set up: only status + Set up rows ---- */
    await openSettingsPage(obsidian, "Advanced");
    await obsidian.win.locator('[data-testid="geode-settings-leave"]').waitFor({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-settings-leave"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');
    await obsidian.win.waitForFunction(
      () => !!document.querySelector('[data-testid="geode-settings-run-wizard"]'),
      undefined,
      { timeout: 15_000 },
    );
    const notsetStatus = await obsidian.eval<string>(
      `document.querySelector('[data-testid="geode-settings-sync-status"] .setting-item-description')?.textContent ?? ""`,
    );
    expect(notsetStatus).toBe("Not set up. No vault connected on this device.");
    expect(await shownSections(obsidian), "only the Status rows after leave").toEqual([]);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
