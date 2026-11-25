import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { startReleaseStub } from "../helpers/release-stub";
import {
  CHECK_FOR_UPDATES_ROW,
  clearNotices,
  closeSettingsPage,
  openSettingsPage,
  readRowControl,
  setRowControl,
} from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";

// #93 & #51 (desktop): real-Obsidian verification of startup plugin update check against a local
// stub (never GitHub), the one-time Notice with obsidian://show-plugin?id=geode, the Plugin version
// and Server version rows in all states, the Advanced Check for updates toggle, and the What's new
// workspace tab opening once after a final version update.

const PASSPHRASE = "plugin-update-whats-new-pass";
const INSTALLED = "1.0.2";
const NEWER = "1.0.3";
const OLDER = "1.0.1";
const SERVER_ROW = '[data-testid="geode-settings-server-update"]';
const PLUGIN_ROW = '[data-testid="geode-settings-plugin-version"]';
const PLUGIN_UPDATE = '[data-testid="geode-settings-plugin-update"]';
const NOTICE_LINK = '[data-testid="geode-plugin-update-notice-link"]';

async function reloadPlugin(o: ObsidianInstance): Promise<void> {
  await o.eval(`
    await app.plugins.disablePlugin("geode");
    await app.plugins.enablePlugin("geode");
    return true;
  `);
  await o.win.waitForFunction(
    () => Boolean((window as any).app?.plugins?.plugins?.geode),
    undefined,
    { timeout: 30_000 },
  );
  await o.eval(`
    const p = app.plugins.plugins.geode;
    if (!p.isUnlocked) await p.unlockVault(${JSON.stringify(PASSPHRASE)});
    return true;
  `);
  await waitForStatusBar(o.win, "Geode: synced", 60_000);
}

test("plugin update check, What's new tab, and version rows (desktop)", async () => {
  test.slow();
  const stub = await startReleaseStub(NEWER);
  const server = await startServer();
  const device = await server.mintToken("plugin-update-desktop");

  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
      checkForUpdates: false,
      lastSeenVersion: OLDER,
    },
    pluginVersion: INSTALLED,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    // On initial launch with lastSeenVersion="1.0.1" and installed final "1.0.2",
    // What's new opens once and records lastSeenVersion="1.0.2".
    await expect(o.win.locator('[data-testid="geode-whats-new"]')).toBeVisible({ timeout: 15_000 });
    expect(await o.eval<string>(`app.plugins.plugins.geode.pluginSettings.lastSeenVersion`))
      .toBe(INSTALLED);

    // Verify rendered markdown inside the What's new view and shoot it.
    await o.eval(`
      const p = app.plugins.plugins.geode;
      p.releases.releaseNotes = [{
        version: ${JSON.stringify(INSTALLED)},
        body: "## Highlights\\n\\n- **Server version** and **Plugin version** rows in Status.\\n- Automatic update check and **What's new** tab.",
      }];
      const leaf = app.workspace.getLeavesOfType("geode-whats-new")[0];
      await leaf.view.render();
      return true;
    `);
    await expect(o.win.locator('[data-testid="geode-whats-new"] h1')).toHaveText(
      `What's new in Geode ${INSTALLED}`,
    );
    await expect(o.win.locator('[data-testid="geode-whats-new"] li')).toHaveCount(2);
    await o.win.waitForTimeout(300);
    await clearNotices(o);
    await o.win.screenshot({ path: shotPath("6-whats-new-desktop.png") });

    // Close the tab, enable Check for updates pointing at the local stub, and reload plugin.
    await o.eval(`
      app.workspace.detachLeavesOfType("geode-whats-new");
      window.__geodeReleaseUrls = {
        latest: ${JSON.stringify(stub.latestUrl)},
        versions: ${JSON.stringify(stub.versionsUrl)},
      };
      const p = app.plugins.plugins.geode;
      p.pluginSettings.checkForUpdates = true;
      await p.saveSettings();
      return true;
    `);
    await reloadPlugin(o);

    // What's new must NOT open a second time after lastSeenVersion was recorded.
    expect(await o.eval<number>(`app.workspace.getLeavesOfType("geode-whats-new").length`)).toBe(0);

    // Startup check against stub fires the one-time Notice with obsidian://show-plugin?id=geode.
    const noticeLink = o.win.locator(NOTICE_LINK).first();
    await expect(noticeLink).toBeVisible({ timeout: 15_000 });
    await expect(noticeLink).toHaveText("Open in community plugins");
    await expect(noticeLink).toHaveAttribute("href", "obsidian://show-plugin?id=geode");
    expect(
      await o.eval<string>(
        `app.plugins.plugins.geode.pluginSettings.lastNotifiedReleaseVersion`,
      ),
    ).toBe(NEWER);
    expect(stub.hits()).toContain("/releases/latest");
    expect(stub.hits()).toContain("/versions.json");
    await o.win.locator(".notice").filter({ hasText: `Geode ${NEWER} is available.` }).first()
      .screenshot({ path: shotPath("7-plugin-update-notice-desktop.png") });

    // Status: Plugin version shows "1.0.2. 1.0.3 is available." + accent Update.
    await clearNotices(o);
    await o.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(INSTALLED)}); return true;`,
    );
    await openSettingsTab(o);
    const pane = o.win.locator(".vertical-tab-content:not(.setting-page)");
    await expect(o.win.locator(`${SERVER_ROW} .setting-item-description`)).toHaveText(
      `${INSTALLED}. Up to date.`,
    );
    await expect(o.win.locator(`${PLUGIN_ROW} .setting-item-description`)).toHaveText(
      `${INSTALLED}. ${NEWER} is available.`,
    );
    await expect(o.win.locator(PLUGIN_UPDATE)).toHaveClass(/mod-cta/);
    await pane.screenshot({ path: shotPath("3-status-plugin-update-desktop.png") });

    // Clicking Plugin version Update opens obsidian://show-plugin?id=geode.
    await o.eval(`
      window.__geodeOpenedUrls = [];
      window.__geodeOrigOpen = window.open;
      window.open = (u) => { window.__geodeOpenedUrls.push(String(u)); return null; };
      return true;
    `);
    await o.win.locator(PLUGIN_UPDATE).click();
    expect(await o.eval<string[]>(`window.__geodeOpenedUrls`)).toEqual([
      "obsidian://show-plugin?id=geode",
    ]);
    await o.eval(`window.open = window.__geodeOrigOpen; return true;`);

    // State 1: both up to date (stub now returns INSTALLED, re-run check).
    stub.setLatest(INSTALLED);
    await o.eval(`await app.plugins.plugins.geode.releases.checkForUpdates(); return true;`);
    await expect(o.win.locator(`${PLUGIN_ROW} .setting-item-description`)).toHaveText(
      `${INSTALLED}. Up to date.`,
    );
    await expect(o.win.locator(PLUGIN_UPDATE)).toHaveCount(0);
    await pane.screenshot({ path: shotPath("1-status-up-to-date-desktop.png") });

    // State 2: server older than plugin -> Server version Update available + accent Update.
    await o.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(OLDER)}); return true;`,
    );
    await expect(o.win.locator(`${SERVER_ROW} .setting-item-description`)).toHaveText(
      `${OLDER}. Update available.`,
    );
    await expect(o.win.locator('[data-testid="geode-settings-update"]')).toHaveClass(/mod-cta/);
    await pane.screenshot({ path: shotPath("2-status-server-update-desktop.png") });
    await o.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(INSTALLED)}); return true;`,
    );

    // State 5: Advanced page shows Check for updates (on) + What's new (Open).
    await openSettingsPage(o, "Advanced");
    expect(await readRowControl(o, CHECK_FOR_UPDATES_ROW)).toBe("on");
    await expect(o.win.locator('[data-testid="geode-settings-whats-new-open"]')).toBeVisible();
    await o.win.locator(".setting-page.vertical-tab-content").screenshot({
      path: shotPath("5-advanced-desktop.png"),
    });

    // Toggle Check for updates OFF -> Plugin version shows bare version, no button.
    await setRowControl(o, CHECK_FOR_UPDATES_ROW);
    await expect.poll(() => readRowControl(o, CHECK_FOR_UPDATES_ROW)).toBe("off");
    expect(await o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.checkForUpdates`))
      .toBe(false);
    await closeSettingsPage(o);
    await expect(o.win.locator(`${PLUGIN_ROW} .setting-item-description`)).toHaveText(INSTALLED);
    await expect(o.win.locator(PLUGIN_UPDATE)).toHaveCount(0);
    await pane.screenshot({ path: shotPath("4-status-check-off-desktop.png") });

    // Re-open Advanced -> What's new Open button opens the What's new tab.
    await openSettingsPage(o, "Advanced");
    await o.win.locator('[data-testid="geode-settings-whats-new-open"]').click();
    await expect(o.win.locator('[data-testid="geode-whats-new"]')).toBeVisible({ timeout: 10_000 });
    expect(o.consoleErrors()).toEqual([]);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
    await stub.close();
  }
});
