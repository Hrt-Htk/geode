import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import {
  AUTO_LOCK_ROW,
  markNoRerender,
  openSettingsPage,
  readScroll,
  rowInventory,
  rowShown,
  scrollSettings,
  shownSections,
} from "../helpers/settings-tab";

// #458: the settings tab has distinct locked and not-set-up layouts, ported from
// mockup #441. Locked: only the Status rows (sync-status row + [Unlock]) and Vault
// (read-only vault-name row), every other section/row hidden. Not set up: only Status
// (status + Set up rows + [Run setup wizard]). Lock/unlock switch in place (marker +
// scrollTop survive); leave/setup re-render the whole tab. Obsidian 1.13+ layout (#16).
const PASSPHRASE = "settings-tab-layouts-pass";

const HIDDEN_WHEN_LOCKED = [
  '[data-testid="geode-settings-storage"]',
  '[data-testid="geode-settings-activity"]',
  '[data-testid="geode-settings-vault-status"]',
  '[data-testid="geode-settings-reconcile"]',
  '[data-testid="geode-settings-push"]',
];

const UNLOCKED_SECTIONS = ["Vault", "Devices", "Sync scope", "Trash", "Advanced"];

/** Shown non-heading rows (locked = 3 incl. the forgot link, notset = 2). */
async function countVisibleRows(o: { eval: <T>(s: string) => Promise<T> }): Promise<number> {
  return (await rowInventory(o)).length;
}

/** Untrusted click: fires the listener without the focus-scroll that moves scrollTop. */
async function clickButton(o: { eval: <T>(s: string) => Promise<T> }, sel: string): Promise<void> {
  await o.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error("clickButton: no element for " + ${JSON.stringify(sel)});
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    })()
  `);
}

test("tab states: locked shows only status+vault rows; unlock restores in place; leave → not set up", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("settings-tab-layouts");
  const o = await launchObsidian({
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
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* Open the settings tab on the Geode tab and keep it open. */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    await o.win.locator('[data-testid="geode-settings-sync-status"]').waitFor({ timeout: 15_000 });

    /* Unlocked baseline: every section, full Status/Vault rows. */
    expect(await shownSections(o)).toEqual(UNLOCKED_SECTIONS);
    await expect(o.win.locator('[data-testid="geode-settings-storage"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-settings-vault-rename"]')).toBeVisible();

    /* Marker on the sync-status row: a re-render would recreate it. The pane must be
       scrollable; locking hides whole sections, so scrollTop clamps by layout (not a
       re-render): the marker is the no-re-render proof, and the unlock transition
       must leave scrollTop unchanged. */
    const markerPresent = await markNoRerender(o);
    /* scrollBeforeLock is the position that must return on unlock: hiding sections
       clamps scrollTop by layout, so the plugin saves it before locking and restores it. */
    const scrollBeforeLock = await scrollSettings(o, 120);
    expect(scrollBeforeLock, "settings pane should be scrollable to a non-zero offset")
      .toBeGreaterThan(0);

    /* ---- Lock (in place): only the status + vault-name rows remain ---- */
    await clickButton(o, '[data-testid="geode-settings-lock"]');
    await expect.poll(
      async () =>
        await o.win
          .locator('[data-testid="geode-settings-sync-status"] .setting-item-description')
          .textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
    await expect(await countVisibleRows(o)).toBe(3);
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-settings-unlock"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-settings-forgot"]')).toBeVisible();
    await expect(
      o.win.locator('[data-testid="geode-settings-vault-name"] .setting-item-description'),
    ).toHaveText(/· 127\.0\.0\.1:\d+$/);
    await expect(o.win.locator('[data-testid="geode-settings-vault-rename"]')).toHaveCount(0);
    for (const sel of HIDDEN_WHEN_LOCKED) {
      await expect(o.win.locator(sel), `hidden while locked: ${sel}`).toBeHidden();
    }
    expect(await rowShown(o, AUTO_LOCK_ROW)).toBe(false);
    expect(await shownSections(o), "only Vault shows while locked").toEqual(["Vault"]);
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await scrollSettings(o, 0);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("458-01-locked.png"),
    });

    /* ---- Unlock (in place): every section/row returns, marker + scroll survive ---- */
    await clickButton(o, '[data-testid="geode-settings-unlock"]');
    const passModal = o.win.locator('.modal:has(:text("Unlock Geode"))');
    await expect(passModal).toBeVisible({ timeout: 10_000 });
    await passModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await passModal.locator('[data-testid="geode-passphrase-input"]').press("Enter");
    await expect(passModal).not.toBeVisible({ timeout: 15_000 });
    await expect.poll(
      async () =>
        await o.win
          .locator('[data-testid="geode-settings-vault-status"] .setting-item-description')
          .textContent(),
      { timeout: 15_000 },
    ).toMatch(/^Unlocked\. /);
    await expect.poll(() => shownSections(o)).toEqual(UNLOCKED_SECTIONS);
    await expect(o.win.locator('[data-testid="geode-settings-vault-rename"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-settings-storage"]')).toBeVisible();
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    expect(
      Math.abs((await readScroll(o)) - scrollBeforeLock),
      "scrollTop restored to the pre-lock position on unlock",
    ).toBeLessThanOrEqual(1);

    /* ---- Leave → not set up: only the status + Set up rows ---- */
    await openSettingsPage(o, "Advanced");
    await o.win.locator('[data-testid="geode-settings-leave"]').waitFor({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-settings-leave"]').click();
    await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();

    await o.win.locator('[data-testid="geode-settings-run-wizard"]').waitFor({ timeout: 15_000 });
    expect(await shownSections(o)).toEqual([]);
    await expect(await countVisibleRows(o)).toBe(2);
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toBeVisible();
    const notsetStatus = await o.win
      .locator('[data-testid="geode-settings-sync-status"] .setting-item-description')
      .textContent();
    expect(notsetStatus).toBe("Not set up. No vault connected on this device.");
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"] .geode-sync-dot-grey'))
      .toBeVisible();
    const setupDesc = await o.eval<string>(
      `Array.from(document.querySelectorAll(".vertical-tab-content .setting-item"))
        .find((i) => i.querySelector(".setting-item-name")?.textContent?.includes("Set up"))
        ?.querySelector(".setting-item-description")?.textContent ?? ""`,
    );
    expect(setupDesc).toBe("Connect this device to a Geode vault.");
    await expect(o.win.locator('[data-testid="geode-settings-leave"]')).toHaveCount(0);
    expect(await rowShown(o, "Advanced")).toBe(false);

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    // The visible pane: a page visited earlier can leave a hidden page container behind.
    await o.win.locator(".vertical-tab-content:visible").screenshot({
      path: shotPath("458-02-notset.png"),
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
