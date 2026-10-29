import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "ui-surfaces-pass";
const VARIANT = process.env.GATE387_VARIANT ?? "after";
const DEVICE_LABEL = "device";
const SURFACES = [
  "settings-devices",
  "settings-plugin-sync",
  "trash",
  "logs",
  "passphrase",
  "export",
];

const SHOT = (surface: string): string => shotPath(`${VARIANT}-${surface}.png`);

// #387 made type-only + promise-only edits to 8 plugin/ui files. This spec renders every affected
// surface (settings tab w/ Devices + plugin-sync list, trash modal, Logs section, passphrase modal,
// export modal), screenshots it, dumps its DOM text, and checks the debug log ring for [error]
// lines. Run once per GATE387_VARIANT (before: origin/main plugin/, after: HEAD) and diff the
// DOM text + PNGs: they must be identical apart from timestamps.

async function dismissAllModals(win: Page): Promise<void> {
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

async function clearNotices(win: Page): Promise<void> {
  await win.evaluate(() => {
    document.querySelectorAll(".notice").forEach((n) => n.remove());
  });
}

async function dumpDom(win: Page, label: string, selector: string): Promise<void> {
  const text = await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el as HTMLElement).innerText : `(no element for ${sel})`;
  }, selector);
  console.log(`=== DOM ${label} ===\n${text}\n=== END ${label} ===`);
}

test("UI surfaces unchanged by #387 type/promise edits", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken(DEVICE_LABEL);

  const o = await launchObsidian({
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
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await dismissAllModals(o.win);

    // Give the plugin-sync list rows to render (injected manifests, one pre-opted-in).
    await o.eval(`
      app.plugins.manifests['dataview'] = { id:'dataview', name:'Dataview', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'d' };
      app.plugins.manifests['templater-obsidian'] = { id:'templater-obsidian', name:'Templater', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'t' };
      const s = app.plugins.plugins.geode.settings;
      s.syncObsidianConfig = true;
      s.syncedPlugins = ['dataview'];
      return true;
    `);

    /* ---- SETTINGS tab: Devices summary + Devices view, expanded plugin-sync list ---- */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await expect(o.win.locator('[data-testid="geode-settings-vault-status"]')).toBeVisible();

    // #433/#447: the settings Devices section is a summary row + [Manage]; the
    // device rows live in the Devices view (device-token list, no admin token).
    const devicesSummary = o.win.locator('[data-testid="geode-settings-devices-summary"]');
    await expect
      .poll(
        async () => await devicesSummary.locator(".setting-item-description").textContent(),
        { timeout: 15_000 },
      )
      .toMatch(/^\d+ devices? · \d+ behind$/);

    // #526: the section's "Rotate admin token" help row (server-side ops, no button).
    const rotateRow = o.win.locator('[data-testid="geode-settings-rotate-admin-token"]');
    await expect(rotateRow).toBeVisible();
    await expect(rotateRow.locator(".setting-item-name")).toHaveText("Rotate admin token");
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-rotate-admin-token"]')?.scrollIntoView({ block: "center" }); return true;`,
    );
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content")
      .screenshot({ path: SHOT("settings-devices-section") })
      .catch(async () => {
        await o.win.screenshot({ path: SHOT("settings-devices-section") });
      });
    await dumpDom(
      o.win,
      "settings-devices-section",
      '[data-testid="geode-settings-devices-summary"]',
    );

    await o.win.locator('[data-testid="geode-settings-devices-manage"]').click();
    const devicesModal = o.win.locator('[data-testid="geode-devices-modal"]');
    await expect(devicesModal).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-device-row"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await devicesModal.screenshot({ path: SHOT("settings-devices") });
    await dumpDom(o.win, "settings-devices", '[data-testid="geode-devices-modal"]');
    await o.eval(
      `document.querySelector('[data-testid="geode-devices-done"]')?.click(); return true;`,
    );

    // #454: the plugin list now lives in the Config to sync Manage modal.
    await o.win.locator('[data-testid="geode-settings-config-manage"]').click();
    const configModal = o.win.locator(".geode-config-modal");
    await expect(configModal).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-config-plugin-dataview"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible();
    await expect(o.win.locator('[data-testid="geode-config-category-hotkeys"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-config-plugin-geode"]')).toHaveCount(0);

    await clearNotices(o.win);
    await configModal.screenshot({ path: SHOT("settings-plugin-sync") })
      .catch(async () => {
        await o.win.screenshot({ path: SHOT("settings-plugin-sync") });
      });

    await dumpDom(o.win, "settings-plugin-sync", ".geode-config-modal");
    await o.eval(`document.querySelector('.geode-config-modal .mod-cta')?.click(); return true;`);
    await o.eval(`app.setting?.close?.(); return true;`);
    await o.win.keyboard.press("Escape").catch(() => {});
    await dismissAllModals(o.win);

    /* ---- TRASH modal via its command (trash is a modal, not a side panel) ---- */
    await o.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    const trash = o.win.locator(".geode-trash-modal");
    await expect.poll(async () => await trash.isVisible().catch(() => false), { timeout: 30_000 })
      .toBe(true);
    await clearNotices(o.win);
    await trash
      .screenshot({ path: SHOT("trash") })
      .catch(async () => {
        await o.win.screenshot({ path: SHOT("trash") });
      });
    await dumpDom(o.win, "trash", ".geode-trash-modal");
    await o.eval(
      `document.querySelector(".geode-trash-modal .modal-close-button")?.click(); return true;`,
    );

    /* ---- LOGS section via the settings tab (Debug logging on; the debug view is gone) ---- */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const logs = sections.find((s) =>
        s.querySelector(".setting-item-heading")?.textContent?.trim() === "Logs");
      if (logs) logs.querySelector(".geode-collapsible-heading")?.click();
      return true;
    `);
    await expect.poll(
      async () =>
        await o.eval<number>(`
        document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line').length
      `),
      { timeout: 30_000 },
    ).toBeGreaterThan(0);
    await clearNotices(o.win);
    await o.eval(`
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content")
      .screenshot({ path: SHOT("logs") })
      .catch(async () => {
        await o.win.screenshot({ path: SHOT("logs") });
      });
    await dumpDom(o.win, "logs", '[data-testid="geode-log-box"]');
    await o.eval(`app.setting?.close?.(); return true;`);
    await o.win.keyboard.press("Escape").catch(() => {});

    /* ---- PASSPHRASE modal: lock via command, then trigger unlock (the real path) ---- */
    await o.eval(`app.commands.executeCommandById("geode:geode-lock"); return true;`);
    await expect.poll(async () => await readGeodeStatusBar(o.win), { timeout: 15_000 })
      .toBe("Geode: locked");
    await o.eval(`app.commands.executeCommandById("geode:geode-unlock"); return true;`);
    const passModal = o.win.locator('.modal:has([data-testid="geode-passphrase-input"])');
    await expect(passModal).toBeVisible({ timeout: 10_000 });
    await clearNotices(o.win);
    await passModal.screenshot({ path: SHOT("passphrase") }).catch(async () => {
      await o.win.screenshot({ path: SHOT("passphrase") });
    });
    await dumpDom(o.win, "passphrase", '.modal:has([data-testid="geode-passphrase-input"])');
    await dismissAllModals(o.win);

    /* ---- EXPORT modal via its command ---- */
    await o.eval(
      `app.commands.executeCommandById("geode:geode-export-decrypted-vault"); return true;`,
    );
    const exportModal = o.win.locator('.modal:has([data-testid="geode-export-folder-input"])');
    await expect(exportModal).toBeVisible({ timeout: 10_000 });
    await clearNotices(o.win);
    await exportModal.screenshot({ path: SHOT("export") }).catch(async () => {
      await o.win.screenshot({ path: SHOT("export") });
    });
    await dumpDom(o.win, "export", '.modal:has([data-testid="geode-export-folder-input"])');
    await dismissAllModals(o.win);

    /* ---- Log-ring oracle: no [error] entries after the whole flow ---- */
    const errors = await o.eval<Array<{ level: string; msg: string }>>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
    );
    console.log(
      "=== LOG RING ERRORS ===\n" + (errors.length ? JSON.stringify(errors, null, 2) : "(none)") +
        "\n=== END ===",
    );
    expect(errors).toEqual([]);
    expect(o.consoleErrors()).toEqual([]);

    console.log("VARIANT:", VARIANT);
    for (const surface of SURFACES) console.log("SHOT:", SHOT(surface));
  } finally {
    await o.close();
    await server.stop?.();
  }
});
