import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #184: the config-to-sync modal lists and toggles community plugins.

const PASSPHRASE = "plugin-sync-pass";
const SHOT_OFF = "plugin-sync-off.png";
const SHOT_MODAL = "plugin-sync-modal.png";

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

test("config-to-sync modal lists and toggles plugins", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("plugin-sync");

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
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissAllModals(obsidian.win);

    /* Inject fake community plugins; start with the master toggle OFF and one plugin pre-opted-in. */
    await obsidian.eval(`
      app.plugins.manifests['dataview'] = { id:'dataview', name:'Dataview', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'d' };
      app.plugins.manifests['templater-obsidian'] = { id:'templater-obsidian', name:'Templater', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'t' };
      const s = app.plugins.plugins.geode.settings;
      s.syncObsidianConfig = false;
      s.syncedPlugins = ['dataview'];
      return true;
    `);

    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    /* ---- OFF state: the Config to sync row must be absent ---- */
    await expect(obsidian.win.locator('[data-testid="geode-settings-config-row"]')).toHaveCount(0);
    await obsidian.win.locator(".modal.mod-settings").screenshot({ path: shotPath(SHOT_OFF) })
      .catch(async () => {
        await obsidian.win.screenshot({ path: shotPath(SHOT_OFF) });
      });

    /* ---- Turn the master toggle ON → the row appears ---- */
    await obsidian.win.locator('[data-testid="geode-settings-toggle-sync-obsidian"]').click();
    await expect(obsidian.win.locator('[data-testid="geode-settings-config-row"]')).toHaveCount(1);

    /* ---- Manage opens the modal: Settings + Community plugins, both open ---- */
    await obsidian.win.locator('[data-testid="geode-settings-config-manage"]').click();
    const modal = obsidian.win.locator(".geode-config-modal");
    await expect(modal).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-settings-heading"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-plugins-heading"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-dataview"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible();
    /* geode itself must NOT appear in the list */
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-geode"]')).toHaveCount(0);
    /* The five settings categories have real toggles */
    await expect(obsidian.win.locator('[data-testid="geode-config-category-hotkeys"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-category-other"]')).toBeVisible();

    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await modal.screenshot({ path: shotPath(SHOT_MODAL) }).catch(async () => {
      await obsidian.win.screenshot({ path: shotPath(SHOT_MODAL) });
    });

    const domText = await obsidian.eval<string>(`
      const el = document.querySelector('.geode-config-modal');
      return el ? el.innerText : '(no modal)';
    `);
    console.log("=== CONFIG MODAL DOM ===\n" + domText + "\n=== END ===");

    /* ---- Toggling a row persists to syncedPlugins ---- */
    await obsidian.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]').click();
    const synced = await obsidian.eval<string>(
      `return JSON.stringify(app.plugins.plugins.geode.settings.syncedPlugins);`,
    );
    console.log("syncedPlugins after toggling templater on: " + synced);
    expect(synced).toContain("templater-obsidian");
    expect(synced).toContain("dataview");

    /* ---- Toggling a category off persists to configCategories ---- */
    await obsidian.win.locator('[data-testid="geode-config-category-hotkeys"]').click();
    const cats = await obsidian.eval<string>(
      `return JSON.stringify(app.plugins.plugins.geode.settings.configCategories);`,
    );
    console.log("configCategories after toggling hotkeys off: " + cats);
    expect(cats).not.toContain("hotkeys");
    expect(cats).toContain("appearance");
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
