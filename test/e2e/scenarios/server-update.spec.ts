import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { enterAdminToken } from "../helpers/admin-token";
import { waitForUnlocked } from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { clearNotices } from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { startUpdateProxy } from "../helpers/update-proxy";
import { statusDir, writeHeartbeat, writeResult } from "../helpers/update-status";
import { waitForStatusBar } from "../helpers/waits";
import packageJson from "../../../package.json" with { type: "json" };

// #44: updating the Geode server from the plugin, against a throwaway server whose host job is
// the test writing the job's own files: the heartbeat says whether the job is installed and
// `result` is the `<status> <epoch>` word the dialog reports. Drives the real surfaces (the
// notice, the Status row, the confirm, the admin token prompt, the progress, one result), and
// the two relays in ../helpers: the counting/failing proxy for what the server cannot show.
const PASSPHRASE = "server-update-pass";
const SERVER_VERSION = packageJson.version;
/** A plugin version the server is behind, so the row and the notice are due. */
const NEWER_PLUGIN = "9.9.9";

const ROW = '[data-testid="geode-settings-server-update"]';
const UPDATE = '[data-testid="geode-settings-update"]';
const COPY = '[data-testid="geode-settings-update-copy"]';
const BANNER_UPDATE = '[data-testid="geode-settings-version-update"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
const NOTICE = ".notice";
const NOTICE_CTA = ".notice-cta";

type Scenario = { server: E2EServer; o: ObsidianInstance; dir: string };

/** One throwaway server whose host job is the test's files, and a real Obsidian synced on it. */
async function scenario(
  name: string,
  opts: { heartbeatAge?: number; pluginVersion?: string } = {},
): Promise<Scenario> {
  const dir = statusDir();
  writeHeartbeat(dir, opts.heartbeatAge ?? 0);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken(name);
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    pluginVersion: opts.pluginVersion,
    unlockPassphrase: PASSPHRASE,
  });
  await waitForUnlocked(o);
  await waitForStatusBar(o.win, "Geode: synced", 60_000);
  return { server, o, dir };
}

/** The dialog, matched on its live class so a closed one is never picked up. */
function dialog(o: ObsidianInstance) {
  return o.win.locator(".modal.geode-confirm");
}

/** One dialog at a time: a reopen closes the previous one, whose fade is still on screen. */
async function openDialog(o: ObsidianInstance, act: () => Promise<void>): Promise<void> {
  await act();
  await expect(dialog(o)).toHaveCount(1, { timeout: 10_000 });
  await o.eval("return new Promise((r) => setTimeout(r, 400));");
}

/** Nothing is mid-close: the overlay of a closing dialog would overlap the next shot. */
async function dialogsGone(o: ObsidianInstance): Promise<void> {
  await expect(dialog(o)).toHaveCount(0, { timeout: 10_000 });
  await o.eval("return new Promise((r) => setTimeout(r, 400));");
}

/** The transport's own refusal event, the way the server's close surfaces: the plugin is the
 * newer side, so the server is the one that has to update. */
function blockServer(o: ObsidianInstance): Promise<void> {
  return o.eval(`
    app.plugins.plugins.geode.transport.dispatchEvent(new CustomEvent("blocked", {
      detail: { server_version: ${JSON.stringify(SERVER_VERSION)}, client_version: ${
    JSON.stringify(NEWER_PLUGIN)
  } },
    }));
    return true;
  `);
}

/** The run's own state, so an assertion is about the run and not about a rendered line. */
function runState(o: ObsidianInstance): Promise<string> {
  return o.eval<string>(`app.plugins.plugins.geode.updater.state.kind`);
}

test("server update: the notice, the row, the confirm, the token, and one result", async () => {
  test.slow();
  const { server, o, dir } = await scenario("server-update", { pluginVersion: NEWER_PLUGIN });

  try {
    /* ---- A: one notice, with Update, once per plugin version ---- */
    const notice = o.win.locator(NOTICE).filter({ hasText: "Server update available." }).first();
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator(NOTICE_CTA)).toHaveText("Update");
    await notice.screenshot({ path: shotPath("44-A-notice-desktop.png") });
    /* The real hello_ack handler again: the seen version makes it one per plugin version. */
    await o.eval(`
      app.plugins.plugins.geode.onServerVersion(${JSON.stringify(SERVER_VERSION)});
      return true;
    `);
    await o.eval(`return new Promise((r) => setTimeout(r, 1_500));`);
    expect(
      await o.win.locator(NOTICE).filter({ hasText: "Server update available." }).count(),
    ).toBe(1);
    expect(await o.eval(`app.plugins.plugins.geode.pluginSettings.updateNoticeVersion`)).toBe(
      NEWER_PLUGIN,
    );
    await clearNotices(o);

    /* ---- B1: the status line keeps the backup age; the row offers the update ---- */
    await openSettingsTab(o);
    const statusRow = o.win.locator(STATUS_ROW);
    await expect.poll(() => statusRow.locator(".setting-item-description").textContent(), {
      timeout: 15_000,
    }).toMatch(/^Up to date\. Last backup /);
    const row = o.win.locator(ROW);
    await expect(row.locator(".setting-item-description")).toHaveText(
      `Server ${SERVER_VERSION}, plugin ${NEWER_PLUGIN}.`,
    );
    await expect(row.locator(UPDATE)).toBeEnabled();
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-B1-row-update-desktop.png"),
    });

    /* Narrow desktop: the mockup's 780x800 window, the narrowest where Obsidian still lays a
       settings row out side by side (its own container query stacks below that). */
    await o.eval(`window.resizeTo(780, 800); return true;`);
    await o.eval(`return new Promise((r) => setTimeout(r, 500));`);
    const width = await o.eval<number>(
      `document.querySelector(".vertical-tab-content").clientWidth`,
    );
    console.log(`narrow desktop: content column ${width}px`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-B1-row-update-desktop-narrow.png"),
    });
    await o.eval(`window.resizeTo(1280, 900); return true;`);

    /* ---- C: the confirm names the blast radius, not a vault count ---- */
    await openDialog(o, () => row.locator(UPDATE).click());
    const modal = dialog(o);
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator(".modal-title")).toHaveText("Update the Geode server?");
    await expect(modal.locator(".geode-confirm-modal p")).toHaveCount(3);
    await o.win.screenshot({ path: shotPath("44-C-confirm-desktop.png") });

    /* ---- D: the session's admin token prompt, asked once ---- */
    await modal.locator('[data-testid="geode-update-confirm"]').click();
    await expect(o.win.locator('[data-testid="geode-admin-token-input"]')).toBeVisible({
      timeout: 10_000,
    });
    await dialogsGone(o);
    await clearNotices(o);
    await o.win.screenshot({ path: shotPath("44-D-token-desktop.png") });
    await enterAdminToken(o);

    /* ---- E1: the same dialog becomes the progress line ---- */
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog(o)).toHaveCount(1);
    await o.eval("return new Promise((r) => setTimeout(r, 400));");
    await expect(dialog(o).locator(".modal-title")).toHaveText("Update the Geode server");
    await o.win.screenshot({ path: shotPath("44-E1-progress-desktop.png") });

    /* ---- F: closing hides the dialog; the row says the update is still running ---- */
    /* The header close button (Obsidian 1.14 draws it as `modal-header-button`). */
    await dialog(o).locator(".modal-header-button, .modal-close-button").click();
    await expect(dialog(o)).toHaveCount(0);
    await expect.poll(() => statusRow.locator(".setting-item-description").textContent(), {
      timeout: 10_000,
    }).toBe("Updating the server.");
    await expect(row.locator(UPDATE)).toBeDisabled();
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-F-row-updating-desktop.png"),
    });

    /* The run finishes behind the closed dialog: the row comes back. */
    writeResult(dir, "updated");
    await expect.poll(() => row.locator(UPDATE).isEnabled(), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => statusRow.locator(".setting-item-description").textContent(), {
      timeout: 20_000,
    }).toMatch(/^Up to date\. Last backup /);
    expect(width, "the narrow window really narrowed").toBeLessThan(520);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: each result word ends the dialog, the token is asked once", async () => {
  test.slow();
  const { server, o, dir } = await scenario("server-update-results", {
    pluginVersion: NEWER_PLUGIN,
  });

  try {
    await clearNotices(o);
    await openSettingsTab(o);
    const row = o.win.locator(ROW);

    /* One run, ending on `word`: confirm, (token: the first run only), progress, result. */
    const run = async (word: string, first = false) => {
      await openDialog(o, () => row.locator(UPDATE).click());
      await dialog(o).locator('[data-testid="geode-update-confirm"]').click();
      if (first) await enterAdminToken(o);
      await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
        timeout: 10_000,
      });
      writeResult(dir, word);
      const text = dialog(o).locator(".geode-confirm-modal p");
      await expect(text).toHaveText(/^(Server|The update|An update)/, { timeout: 20_000 });
      return text;
    };

    /* E2: updated, with the version the server answers now. */
    const updated = await run("updated", true);
    await expect(updated).toHaveText(`Server updated to ${SERVER_VERSION}.`);
    await expect(dialog(o).locator('[data-testid="geode-update-copy"]')).toHaveCount(0);
    await o.win.screenshot({ path: shotPath("44-E2-result-updated-desktop.png") });
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E3: nothing to do. */
    const upToDate = await run("up-to-date");
    await expect(upToDate).toHaveText("Server is already up to date.");
    await o.win.screenshot({ path: shotPath("44-E3-result-already-desktop.png") });
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E4: the job's rate limit. */
    const rateLimited = await run("rate-limited");
    await expect(rateLimited).toHaveText("An update ran recently. Try again in a few minutes.");
    await o.win.screenshot({ path: shotPath("44-E4-result-rate-limited-desktop.png") });
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E5: a failed run shows the version it is back on, and the command. */
    const failed = await run("rolled-back");
    await expect(failed).toHaveText(`The update failed. The server is back on ${SERVER_VERSION}.`);
    await expect(dialog(o).locator(".geode-code-row code")).toHaveText(
      "docker compose pull && docker compose up -d",
    );
    await o.win.screenshot({ path: shotPath("44-E5-result-failed-desktop.png") });
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E6: a run that never happened, same command. */
    const notRun = await run("no-flock");
    await expect(notRun).toHaveText("The update did not run. Copy the command below.");
    await o.win.screenshot({ path: shotPath("44-E6-result-not-run-desktop.png") });
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* The token was asked for the first run only: the rest ran on the session's copy. */
    expect(await o.eval(`app.plugins.plugins.geode.adminToken`)).toBe("e2e");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: no job means the command, and a notice without an action", async () => {
  test.slow();
  // A heartbeat the job would have written four minutes ago: gone, not installed.
  const { server, o } = await scenario("server-update-no-job", {
    heartbeatAge: 240,
    pluginVersion: NEWER_PLUGIN,
  });

  try {
    const notice = o.win.locator(NOTICE).filter({ hasText: "Server update available." }).first();
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator(NOTICE_CTA)).toHaveCount(0);
    await clearNotices(o);

    await openSettingsTab(o);
    const row = o.win.locator(ROW);
    await expect(row.locator(".setting-item-description")).toHaveText(
      "The update job is not installed. Run the command on the server.",
    );
    await expect(row.locator(COPY)).toHaveText("Copy command");
    await expect(row.locator(UPDATE)).toHaveCount(0);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-B2-row-no-job-desktop.png"),
    });
    /* No job anywhere on the screen: the settings row is the only way to the command. */
    await expect(row.locator(COPY)).toBeEnabled();
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: matching versions show the version and no control", async () => {
  test.slow();
  const { server, o } = await scenario("server-update-match");

  try {
    await o.eval(`return new Promise((r) => setTimeout(r, 1_500));`);
    expect(
      await o.win.locator(NOTICE).filter({ hasText: "Server update available." }).count(),
    ).toBe(0);
    await openSettingsTab(o);
    const row = o.win.locator(ROW);
    await expect(row.locator(".setting-item-description")).toHaveText(
      `Server ${SERVER_VERSION}.`,
    );
    await expect(row.locator("button")).toHaveCount(0);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-B3-row-match-desktop.png"),
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: a refused server keeps the row to the versions, the banner acts", async () => {
  test.slow();
  const { server, o } = await scenario("server-update-blocked", {
    pluginVersion: NEWER_PLUGIN,
  });

  try {
    await clearNotices(o);
    await blockServer(o);
    await openSettingsTab(o);
    const banner = o.win.locator('[data-testid="geode-settings-version-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner.locator(".setting-item-description")).toHaveText(
      "Update the Geode server, then reload Obsidian.",
    );
    await expect(banner.locator(BANNER_UPDATE)).toHaveText("Update");
    const row = o.win.locator(ROW);
    await expect(row.locator(".setting-item-description")).toHaveText(
      `Server ${SERVER_VERSION}, plugin ${NEWER_PLUGIN}.`,
    );
    await expect(row.locator("button")).toHaveCount(0);
    await clearNotices(o);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("44-B4-blocked-banner-desktop.png"),
    });
    /* The banner's Update is the way in while the row keeps to the versions. */
    await openDialog(o, () => banner.locator(BANNER_UPDATE).click());
    await expect(dialog(o).locator(".modal-title")).toHaveText("Update the Geode server?");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: Update again while a run is going reopens that run, not a new one", async () => {
  test.slow();
  const { server, o, dir } = await scenario("server-update-again", {
    pluginVersion: NEWER_PLUGIN,
  });

  try {
    await clearNotices(o);
    await blockServer(o);
    await openSettingsTab(o);
    const bannerUpdate = o.win.locator(BANNER_UPDATE);
    await expect(bannerUpdate).toBeVisible({ timeout: 15_000 });
    await openDialog(o, () => bannerUpdate.click());
    await dialog(o).locator('[data-testid="geode-update-confirm"]').click();
    await enterAdminToken(o);
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });

    /* Closed mid run, the way the close button leaves it. */
    await dialog(o).locator(".modal-header-button, .modal-close-button").click();
    await dialogsGone(o);
    expect(await runState(o)).toBe("running");

    /* The banner's Update again: the run is still going, so the dialog shows it and no second
       request is one click away. */
    await openDialog(o, () => bannerUpdate.click());
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible();
    await expect(dialog(o).locator('[data-testid="geode-update-confirm"]')).toHaveCount(0);
    expect(await runState(o)).toBe("running");

    /* One result ends that one run. */
    writeResult(dir, "updated");
    await expect(dialog(o).locator(".geode-confirm-modal p")).toHaveText(
      `Server updated to ${SERVER_VERSION}.`,
      { timeout: 20_000 },
    );
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: a rotated admin token asks again instead of ending the run", async () => {
  test.slow();
  const { server, o, dir } = await scenario("server-update-rotated-token", {
    pluginVersion: NEWER_PLUGIN,
  });

  try {
    /* A privileged action earlier in the session cached a token the server no longer accepts. */
    await o.eval(`app.plugins.plugins.geode.adminToken = "stale-token"; return true;`);
    await openSettingsTab(o);
    await openDialog(o, () => o.win.locator(UPDATE).click());
    await dialog(o).locator('[data-testid="geode-update-confirm"]').click();

    /* The POST is refused: the prompt comes back, the run does not end as "did not run". */
    await expect(o.win.locator('[data-testid="geode-admin-token-input"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog(o).locator(".geode-confirm-modal p")).toHaveCount(0);
    expect(await o.eval(`app.plugins.plugins.geode.adminToken`)).toBeNull();

    await enterAdminToken(o);
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });
    writeResult(dir, "updated");
    await expect(dialog(o).locator(".geode-confirm-modal p")).toHaveText(
      `Server updated to ${SERVER_VERSION}.`,
      { timeout: 20_000 },
    );
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("server update: unloading the plugin stops the run's polling", async () => {
  test.slow();
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const proxy = await startUpdateProxy(server.url);
  const device = await server.mintToken("server-update-unload");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: proxy.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    /* The run itself is HTTP only, so the row and the notice are not needed to start one. */
    await o.eval(`app.plugins.plugins.geode.updater.prompt(); return true;`);
    await expect(dialog(o)).toHaveCount(1, { timeout: 10_000 });
    await dialog(o).locator('[data-testid="geode-update-confirm"]').click();
    await enterAdminToken(o);
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(proxy.statusReads, { timeout: 15_000 }).toBeGreaterThan(0);

    /* A BRAT reload while a tick is provably mid read: that tick must not schedule the next. */
    proxy.holdNextStatusRead(3_000);
    const before = proxy.statusReads();
    await expect.poll(proxy.statusReads, { timeout: 10_000 }).toBeGreaterThan(before);
    await o.eval(`await app.plugins.disablePlugin("geode"); return true;`);
    const frozen = proxy.statusReads();
    await o.eval("return new Promise((r) => setTimeout(r, 5_000));");
    expect(proxy.statusReads(), "the dead run's polling stopped").toBe(frozen);
  } finally {
    await o.close();
    await proxy.close();
    await server.stop().catch(() => {});
  }
});

test("server update: the result waits for the version the server runs now", async () => {
  test.slow();
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const proxy = await startUpdateProxy(server.url);
  const device = await server.mintToken("server-update-version");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: proxy.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    pluginVersion: NEWER_PLUGIN,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await o.eval(`app.plugins.plugins.geode.updater.prompt(); return true;`);
    await expect(dialog(o)).toHaveCount(1, { timeout: 10_000 });
    await dialog(o).locator('[data-testid="geode-update-confirm"]').click();
    await enterAdminToken(o);
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });

    /* The job says updated, but /version cannot answer: the word alone names no version. */
    proxy.failVersion(true);
    writeResult(dir, "updated");
    await o.eval("return new Promise((r) => setTimeout(r, 5_000));");
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible();
    await expect(dialog(o).locator(".geode-confirm-modal p")).toHaveCount(0);
    expect(await runState(o)).toBe("running");

    /* It answers again: the next tick finishes with the version it holds. */
    proxy.failVersion(false);
    await expect(dialog(o).locator(".geode-confirm-modal p")).toHaveText(
      `Server updated to ${SERVER_VERSION}.`,
      { timeout: 15_000 },
    );
  } finally {
    await o.close();
    await proxy.close();
    await server.stop().catch(() => {});
  }
});
