import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { enterAdminToken } from "../helpers/admin-token";
import { expectFits } from "../helpers/fit";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { openSettingsTab } from "../helpers/logs";
import { clearNotices } from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { statusDir, writeHeartbeat, writeResult } from "../helpers/update-status";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import packageJson from "../../../package.json" with { type: "json" };

// #44 (phone): the same surfaces on the real device, and the phone-only question a screenshot
// cannot answer: does the dialog fit, and does the command wrap instead of scrolling?
// The plugin's version is raised in memory (the desktop spec installs a real 9.9.9 manifest):
// the row and the notice only compare it with the server's, which the real hello_ack handler
// is then driven with.
const PASSPHRASE = "server-update-phone-pass";
const SERVER_VERSION = packageJson.version;
const NEWER_PLUGIN = "9.9.9";

const ROW = '[data-testid="geode-settings-server-update"]';
const UPDATE = '[data-testid="geode-settings-update"]';
const COPY = '[data-testid="geode-settings-update-copy"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
const DIALOG = ".modal.geode-confirm";
const BANNER = '[data-testid="geode-settings-version-banner"]';

/** Let a modal's appear animation finish: a screencap mid-fade has no backdrop yet. */
async function settle(ui: { eval: (js: string) => Promise<unknown> }): Promise<void> {
  await ui.eval("return new Promise((r) => setTimeout(r, 600));");
}

/** The row's text on the device, read in page (Playwright locators never settle on mobile). */
async function rowText(ui: { eval: (js: string) => Promise<unknown> }, selector: string) {
  return await ui.eval<string>(`(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    return row ? row.querySelector(".setting-item-description")?.textContent ?? "" : "";
  })()`);
}

test("server update (phone): notice, row, confirm, progress, and both command results", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await useRemoteServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update");

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
    await expect.poll(() => readGeodeStatusBar(obsidian.win), { timeout: 30_000 }).toBe(
      "Geode: locked",
    );
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 90_000);
    await dismissModals(obsidian);

    /* The plugin reports a version the server is behind, then the real handler runs. The
       notice is once per plugin version, and that setting outlives a previous run. */
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.pluginSettings.updateNoticeVersion = "";
      await p.saveSettings();
      p.manifest.version = ${JSON.stringify(NEWER_PLUGIN)};
      p.onServerVersion(${JSON.stringify(SERVER_VERSION)});
      return true;
    `);

    /* ---- A: the notice carries the action, in one row ---- */
    await expect
      .poll(
        () => obsidian.eval<number>(`document.querySelectorAll(".notice-cta").length`),
        { timeout: 20_000 },
      )
      .toBe(1);
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-A-notice-phone.png"));

    /* ---- B1: the status line keeps the age, the row offers the update ---- */
    await clearNotices(obsidian);
    await openSettingsTab(obsidian, true);
    await expect.poll(() => rowText(obsidian, ROW), { timeout: 20_000 }).toBe(
      `Server ${SERVER_VERSION}, plugin ${NEWER_PLUGIN}.`,
    );
    expect(await rowText(obsidian, STATUS_ROW)).toMatch(/^Up to date\. Last backup /);
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-B1-row-update-phone.png"));

    /* ---- C: the confirm fits the screen ---- */
    await evalClick(obsidian, UPDATE);
    await expect.poll(
      () => obsidian.eval<number>(`document.querySelectorAll(${JSON.stringify(DIALOG)}).length`),
      { timeout: 20_000 },
    ).toBe(1);
    const confirm = obsidian.win.locator(DIALOG);
    await expect(confirm.locator(".modal-title")).toHaveText("Update the Geode server?");
    await expectFits(confirm);
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-C-confirm-phone.png"));

    /* ---- D then E1: the token prompt, then progress in the same dialog ---- */
    await evalClick(obsidian, '[data-testid="geode-update-confirm"]');
    await enterAdminToken(obsidian);
    await expect.poll(
      () =>
        obsidian.eval<boolean>(
          `!!document.querySelector('[data-testid="geode-update-progress"]')`,
        ),
      { timeout: 20_000 },
    ).toBe(true);
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-E1-progress-phone.png"));

    /* ---- E5: a failed run shows the version and the command, which wraps here ---- */
    writeResult(dir, "rolled-back");
    await expect
      .poll(
        () =>
          obsidian.eval<string>(
            `document.querySelector("${DIALOG} .geode-confirm-modal p")?.textContent ?? ""`,
          ),
        {
          timeout: 30_000,
        },
      )
      .toBe(`The update failed. The server is back on ${SERVER_VERSION}.`);
    await expect(obsidian.win.locator(`${DIALOG} .geode-code-row code`)).toContainText(
      "docker compose up",
    );
    await expectFits(obsidian.win.locator(DIALOG));
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-E5-result-failed-phone.png"));
    await evalClick(obsidian, '[data-testid="geode-update-done"]');

    /* ---- E6: a run that did not happen, same command ---- */
    await evalClick(obsidian, UPDATE);
    await expect.poll(
      () => obsidian.eval<number>(`document.querySelectorAll(${JSON.stringify(DIALOG)}).length`),
      { timeout: 20_000 },
    ).toBe(1);
    await evalClick(obsidian, '[data-testid="geode-update-confirm"]');
    await expect.poll(
      () =>
        obsidian.eval<boolean>(
          `!!document.querySelector('[data-testid="geode-update-progress"]')`,
        ),
      { timeout: 20_000 },
    ).toBe(true);
    writeResult(dir, "no-flock");
    await expect
      .poll(
        () =>
          obsidian.eval<string>(
            `document.querySelector("${DIALOG} .geode-confirm-modal p")?.textContent ?? ""`,
          ),
        {
          timeout: 30_000,
        },
      )
      .toBe("The update did not run. Copy the command below.");
    await expectFits(obsidian.win.locator(DIALOG));
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-E6-result-not-run-phone.png"));
    await evalClick(obsidian, '[data-testid="geode-update-done"]');
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});

test("server update (phone): no job, and a refused server", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();
  const dir = statusDir();
  writeHeartbeat(dir, 240);
  const server = await useRemoteServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update-no-job");

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
    await expect.poll(() => readGeodeStatusBar(obsidian.win), { timeout: 30_000 }).toBe(
      "Geode: locked",
    );
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 90_000);
    await dismissModals(obsidian);
    /* The notice is once per plugin version and the setting outlives the previous spec, so
       this run starts as a fresh plugin version would. */
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.pluginSettings.updateNoticeVersion = "";
      await p.saveSettings();
      p.manifest.version = ${JSON.stringify(NEWER_PLUGIN)};
      p.onServerVersion(${JSON.stringify(SERVER_VERSION)});
      return true;
    `);

    /* The notice is due, but without an action: the settings row carries the command. */
    await expect
      .poll(
        () => obsidian.eval<number>(`document.querySelectorAll(".notice").length`),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    expect(await obsidian.eval<number>(`document.querySelectorAll(".notice-cta").length`)).toBe(0);
    await clearNotices(obsidian);

    await openSettingsTab(obsidian, true);
    await expect.poll(() => rowText(obsidian, ROW), { timeout: 20_000 }).toBe(
      "The update job is not installed. Run the command on the server.",
    );
    expect(await obsidian.eval<boolean>(`!!document.querySelector(${JSON.stringify(COPY)})`)).toBe(
      true,
    );
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-B2-row-no-job-phone.png"));

    /* ---- B4: the refusal keeps its action on the banner, the row to the versions ---- */
    await obsidian.eval(`
      app.plugins.plugins.geode.transport.dispatchEvent(new CustomEvent("blocked", {
        detail: { server_version: ${JSON.stringify(SERVER_VERSION)}, client_version: ${
      JSON.stringify(NEWER_PLUGIN)
    } },
      }));
      return true;
    `);
    await expect
      .poll(() => obsidian.eval<boolean>(`!!document.querySelector(${JSON.stringify(BANNER)})`), {
        timeout: 20_000,
      })
      .toBe(true);
    await expect.poll(() => rowText(obsidian, ROW), { timeout: 10_000 }).toBe(
      `Server ${SERVER_VERSION}, plugin ${NEWER_PLUGIN}.`,
    );
    expect(await obsidian.eval<boolean>(`!!document.querySelector(${JSON.stringify(UPDATE)})`))
      .toBe(
        false,
      );
    await clearNotices(obsidian);
    await obsidian.eval(
      `document.querySelector(".vertical-tab-content")?.scrollTo(0, 0); return true;`,
    );
    await settle(obsidian);
    await obsidian.screenshot(shotPath("44-B4-blocked-banner-phone.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
