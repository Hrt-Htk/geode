import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
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
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

// #93 & #51 (phone): on-device verification of update check (via adb-reversed local stub),
// Notice, Plugin version / Server version rows in all states, Advanced toggle, and What's new tab.

const PASSPHRASE = "plugin-update-phone-pass";
const INSTALLED = "1.0.2";
const NEWER = "1.0.3";
const OLDER = "1.0.1";
const SERVER_ROW = '[data-testid="geode-settings-server-update"]';
const PLUGIN_ROW = '[data-testid="geode-settings-plugin-version"]';
const PLUGIN_UPDATE = '[data-testid="geode-settings-plugin-update"]';
const NOTICE_LINK = '[data-testid="geode-plugin-update-notice-link"]';

function adb(args: string[]): void {
  const serial = process.env.ANDROID_SERIAL;
  const adbPath = process.env.ADB_PATH || "adb";
  const res = spawnSync(adbPath, [...(serial ? ["-s", serial] : []), ...args], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (res.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${res.stderr?.trim() || "unknown"}`);
  }
}

async function settle(ui: { eval: (js: string) => Promise<unknown> }): Promise<void> {
  await ui.eval("return new Promise((r) => setTimeout(r, 600));");
}

function rowDesc(ui: { eval: <T>(js: string) => Promise<T> }, selector: string) {
  return ui.eval<string>(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    return row?.querySelector(".setting-item-description")?.textContent ?? "";
  })()`);
}

test("plugin update check, What's new tab, and version rows (phone)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();
  const stub = await startReleaseStub(NEWER);
  adb(["reverse", `tcp:${stub.port}`, `tcp:${stub.port}`]);
  const server = await useRemoteServer();
  const device = await server.mintToken("plugin-update-phone");

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
    await expect.poll(() => readGeodeStatusBar(obsidian.win), { timeout: 30_000 }).toBe(
      "Geode: locked",
    );
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 90_000);
    await dismissModals(obsidian);

    // Point check at adb-reversed local stub, set installed version & prior lastSeenVersion,
    // and trigger the real startup routines on-device.
    await obsidian.eval(`
      window.__geodeReleaseUrls = {
        latest: ${JSON.stringify(stub.latestUrl)},
        versions: ${JSON.stringify(stub.versionsUrl)},
      };
      const p = app.plugins.plugins.geode;
      window.__geodeOrigManifestVersion = p.manifest.version;
      p.manifest.version = ${JSON.stringify(INSTALLED)};
      p.pluginSettings.checkForUpdates = true;
      p.pluginSettings.lastNotifiedReleaseVersion = "";
      p.pluginSettings.lastSeenVersion = ${JSON.stringify(OLDER)};
      p.releases.releaseNotes = [{
        version: ${JSON.stringify(INSTALLED)},
        body: "## Highlights\\n\\n- **Server version** and **Plugin version** rows in Status.\\n- Automatic update check and **What's new** tab.",
      }];
      await p.saveSettings();
      await p.releases.checkWhatsNewOnStartup();
      return true;
    `);

    await expect.poll(
      () => obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-whats-new"]')`),
      { timeout: 15_000 },
    ).toBe(true);
    await clearNotices(obsidian);
    await settle(obsidian);
    await obsidian.screenshot(shotPath("6-whats-new-phone.png"));

    // Run startup check against stub -> one-time Notice on phone.
    await obsidian.eval(`
      await app.plugins.plugins.geode.releases.checkForUpdates();
      return true;
    `);
    await expect.poll(
      () => obsidian.eval<boolean>(`!!document.querySelector(${JSON.stringify(NOTICE_LINK)})`),
      { timeout: 15_000 },
    ).toBe(true);
    await settle(obsidian);
    await obsidian.screenshot(shotPath("7-plugin-update-notice-phone.png"));

    // State 3: Plugin update available in Status.
    await clearNotices(obsidian);
    await obsidian.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(INSTALLED)}); return true;`,
    );
    await openSettingsTab(obsidian, true);
    await expect.poll(() => rowDesc(obsidian, PLUGIN_ROW), { timeout: 15_000 }).toBe(
      `${INSTALLED}. ${NEWER} is available.`,
    );
    expect(
      await obsidian.eval<boolean>(`!!document.querySelector(${JSON.stringify(PLUGIN_UPDATE)})`),
    ).toBe(true);
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("3-status-plugin-update-phone.png"));

    // State 1: Both up to date.
    stub.setLatest(INSTALLED);
    await obsidian.eval(`await app.plugins.plugins.geode.releases.checkForUpdates(); return true;`);
    await expect.poll(() => rowDesc(obsidian, PLUGIN_ROW), { timeout: 15_000 }).toBe(
      `${INSTALLED}. Up to date.`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("1-status-up-to-date-phone.png"));

    // State 2: Server update available.
    await obsidian.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(OLDER)}); return true;`,
    );
    await expect.poll(() => rowDesc(obsidian, SERVER_ROW), { timeout: 15_000 }).toBe(
      `${OLDER}. Update available.`,
    );
    await settle(obsidian);
    await clearNotices(obsidian);
    await obsidian.screenshot(shotPath("2-status-server-update-phone.png"));
    await obsidian.eval(
      `app.plugins.plugins.geode.onServerVersion(${JSON.stringify(INSTALLED)}); return true;`,
    );

    // State 5: Advanced page.
    await openSettingsPage(obsidian, "Advanced");
    expect(await readRowControl(obsidian, CHECK_FOR_UPDATES_ROW)).toBe("on");
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("5-advanced-phone.png"));

    // State 4: Check for updates off -> bare Plugin version.
    await setRowControl(obsidian, CHECK_FOR_UPDATES_ROW);
    await expect.poll(() => readRowControl(obsidian, CHECK_FOR_UPDATES_ROW)).toBe("off");
    await closeSettingsPage(obsidian);
    await expect.poll(() => rowDesc(obsidian, PLUGIN_ROW), { timeout: 15_000 }).toBe(INSTALLED);
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("4-status-check-off-phone.png"));

    // Open What's new via Advanced -> Open button.
    await openSettingsPage(obsidian, "Advanced");
    await evalClick(obsidian, '[data-testid="geode-settings-whats-new-open"]');
    await expect.poll(
      () => obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-whats-new"]')`),
      { timeout: 15_000 },
    ).toBe(true);
  } finally {
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      if (p && window.__geodeOrigManifestVersion) {
        p.manifest.version = window.__geodeOrigManifestVersion;
        delete window.__geodeOrigManifestVersion;
      }
      return true;
    `).catch(() => {});
    await clearNotices(obsidian).catch(() => {});
    await obsidian.close();
    await server.stop().catch(() => {});
    await stub.close();
    try {
      adb(["reverse", "--remove", `tcp:${stub.port}`]);
    } catch {
      // ignore cleanup error if device dropped
    }
  }
});
