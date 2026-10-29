import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #184: on-device: the config-to-sync modal lists and toggles plugins.

const PASSPHRASE = "plugin-sync-pass";
const SHOT_MODAL = "plugin-sync-modal.phone.png";

test("config-to-sync modal lists and toggles plugins (phone)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("plugin-sync");

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
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    await obsidian.eval(`
      app.plugins.manifests['dataview'] = { id:'dataview', name:'Dataview', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'d' };
      app.plugins.manifests['templater-obsidian'] = { id:'templater-obsidian', name:'Templater', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'t' };
      const s = app.plugins.plugins.geode.settings;
      s.syncObsidianConfig = true;
      s.syncedPlugins = ['dataview'];
      return true;
    `);

    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);

    const row = obsidian.win.locator('[data-testid="geode-settings-config-row"]');
    await expect(row).toHaveCount(1, { timeout: 15_000 });

    await obsidian.eval(`
      document.querySelector('[data-testid="geode-settings-config-manage"]')?.click();
      return true;
    `);
    const modal = obsidian.win.locator(".geode-config-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-dataview"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-category-hotkeys"]'))
      .toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-config-plugin-geode"]')).toHaveCount(0);

    const domText = await obsidian.eval<string>(`
      const el = document.querySelector('.geode-config-modal');
      return el ? el.innerText : '(no modal)';
    `);
    console.log("=== PHONE CONFIG MODAL DOM ===\n" + domText + "\n=== END ===");

    /* Clear transient sync Notices so they don't overlay the capture. */
    await obsidian.eval(`
      document.querySelectorAll('.notice').forEach((n) => n.remove());
      return true;
    `);
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath(SHOT_MODAL));

    /* Toggling a row persists (in-page eval-click; mobile taps can be flaky via locator). */
    await obsidian.eval(`
      document.querySelector('[data-testid="geode-config-plugin-templater-obsidian"]').click();
      return true;
    `);
    const synced = await obsidian.eval<string>(
      `return JSON.stringify(app.plugins.plugins.geode.settings.syncedPlugins);`,
    );
    console.log("PHONE syncedPlugins after toggling templater: " + synced);
    expect(synced).toContain("templater-obsidian");
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
