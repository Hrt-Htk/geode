import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { enterAdminToken } from "../helpers/admin-token";
import { waitForUnlocked } from "../helpers/geode";
import { clearNotices, rowShown } from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";
import packageJson from "../../../package.json" with { type: "json" };

// #44: updating the Geode server from the plugin, against a throwaway server whose host job
// is the test writing the job's own files: the heartbeat says whether the job is installed and
// `result` is the `<status> <epoch>` word the dialog reports. Drives the real surfaces (the
// notice, the Status row, the confirm, the admin token prompt, the progress, one result).
const PASSPHRASE = "server-update-pass";
const SERVER_VERSION = packageJson.version;
/** A plugin version the server is behind, so the row and the notice are due. */
const NEWER_PLUGIN = "9.9.9";

const ROW = '[data-testid="geode-settings-server-update"]';
const UPDATE = '[data-testid="geode-settings-update"]';
const COPY = '[data-testid="geode-settings-update-copy"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
const NOTICE = ".notice";
const NOTICE_CTA = ".notice-cta";

const epochNow = () => Math.floor(Date.now() / 1000);

/** The job's own state folder (`GEODE_UPDATE_STATUS_DIR` on the throwaway server). */
function statusDir(): string {
  return mkdtempSync(path.join(tmpdir(), "geode-update-status-"));
}

/** The heartbeat the job writes on every run: fresh means installed, old means gone. */
function writeHeartbeat(dir: string, ageSeconds = 0): void {
  writeFileSync(`${dir}/heartbeat`, `${epochNow() - ageSeconds}\n`);
}

/** One run's result, dated now so it answers the request the plugin just left. */
function writeResult(dir: string, word: string): void {
  writeFileSync(`${dir}/result`, `${word} ${epochNow()}\n`);
}

async function openSettings(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
  await expect.poll(() => rowShown(o, "Sync status"), { timeout: 15_000 }).toBe(true);
}

/** The dialog, matched on its live title so a closed one is never picked up. */
function dialog(o: Awaited<ReturnType<typeof launchObsidian>>) {
  return o.win.locator(".modal.geode-confirm");
}

/** One dialog at a time: a reopen closes the previous one, whose fade is still on screen. */
async function openDialog(
  o: Awaited<ReturnType<typeof launchObsidian>>,
  act: () => Promise<void>,
) {
  await act();
  await expect(dialog(o)).toHaveCount(1, { timeout: 10_000 });
  await o.eval("return new Promise((r) => setTimeout(r, 400));");
}

/** The dialog inside its window: an element crop of a modal carries a strip of what is behind
 * it (Obsidian paints the modal offset from its box here), and the window stays honest. */
async function shootDialog(
  o: Awaited<ReturnType<typeof launchObsidian>>,
  name: string,
): Promise<void> {
  await o.win.screenshot({ path: shotPath(name) });
}

/** Nothing is mid-close: the overlay of a closing dialog would overlap the next shot. */
async function dialogsGone(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<void> {
  await expect(dialog(o)).toHaveCount(0, { timeout: 10_000 });
  await o.eval("return new Promise((r) => setTimeout(r, 400));");
}

test("server update: the notice, the row, the confirm, the token, and one result", async () => {
  test.slow();
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    pluginVersion: NEWER_PLUGIN,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

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
    await openSettings(o);
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
    await shootDialog(o, "44-C-confirm-desktop.png");

    /* ---- D: the session's admin token prompt, asked once ---- */
    await modal.locator('[data-testid="geode-update-confirm"]').click();
    await expect(o.win.locator('[data-testid="geode-admin-token-input"]')).toBeVisible({
      timeout: 10_000,
    });
    await dialogsGone(o);
    await clearNotices(o);
    await shootDialog(o, "44-D-token-desktop.png");
    await enterAdminToken(o);

    /* ---- E1: the same dialog becomes the progress line ---- */
    await expect(dialog(o).locator('[data-testid="geode-update-progress"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog(o)).toHaveCount(1);
    await o.eval("return new Promise((r) => setTimeout(r, 400));");
    await expect(dialog(o).locator(".modal-title")).toHaveText("Update the Geode server");
    await shootDialog(o, "44-E1-progress-desktop.png");

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
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update-results");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    pluginVersion: NEWER_PLUGIN,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await clearNotices(o);
    await openSettings(o);
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
    await shootDialog(o, "44-E2-result-updated-desktop.png");
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E3: nothing to do. */
    const upToDate = await run("up-to-date");
    await expect(upToDate).toHaveText("Server is already up to date.");
    await shootDialog(o, "44-E3-result-already-desktop.png");
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E4: the job's rate limit. */
    const rateLimited = await run("rate-limited");
    await expect(rateLimited).toHaveText("An update ran recently. Try again in a few minutes.");
    await shootDialog(o, "44-E4-result-rate-limited-desktop.png");
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E5: a failed run shows the version it is back on, and the command. */
    const failed = await run("rolled-back");
    await expect(failed).toHaveText(`The update failed. The server is back on ${SERVER_VERSION}.`);
    await expect(dialog(o).locator(".geode-code-row code")).toHaveText(
      "docker compose pull && docker compose up -d",
    );
    await shootDialog(o, "44-E5-result-failed-desktop.png");
    await dialog(o).locator('[data-testid="geode-update-done"]').click();
    await dialogsGone(o);

    /* E6: a run that never happened, same command. */
    const notRun = await run("no-flock");
    await expect(notRun).toHaveText("The update did not run. Copy the command below.");
    await shootDialog(o, "44-E6-result-not-run-desktop.png");
    await dialog(o).locator('[data-testid="geode-update-done"]').click();

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
  const dir = statusDir();
  writeHeartbeat(dir, 240);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update-no-job");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    pluginVersion: NEWER_PLUGIN,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    const notice = o.win.locator(NOTICE).filter({ hasText: "Server update available." }).first();
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.locator(NOTICE_CTA)).toHaveCount(0);
    await clearNotices(o);

    await openSettings(o);
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
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update-match");
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
    await o.eval(`return new Promise((r) => setTimeout(r, 1_500));`);
    expect(
      await o.win.locator(NOTICE).filter({ hasText: "Server update available." }).count(),
    ).toBe(0);
    await openSettings(o);
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
  const dir = statusDir();
  writeHeartbeat(dir);
  const server = await startServer({ env: { GEODE_UPDATE_STATUS_DIR: dir } });
  const device = await server.mintToken("server-update-blocked");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    pluginVersion: NEWER_PLUGIN,
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await clearNotices(o);
    /* The transport's own refusal event, the way the server's close surfaces: the plugin is
       the newer side, so the server is the one that has to update. */
    await o.eval(`
      app.plugins.plugins.geode.transport.dispatchEvent(new CustomEvent("blocked", {
        detail: { server_version: ${JSON.stringify(SERVER_VERSION)}, client_version: ${
      JSON.stringify(NEWER_PLUGIN)
    } },
      }));
      return true;
    `);
    await openSettings(o);
    const banner = o.win.locator('[data-testid="geode-settings-version-banner"]');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner.locator(".setting-item-description")).toHaveText(
      "Update the Geode server, then reload Obsidian.",
    );
    await expect(banner.locator('[data-testid="geode-settings-version-update"]')).toHaveText(
      "Update",
    );
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
    await openDialog(
      o,
      () => banner.locator('[data-testid="geode-settings-version-update"]').click(),
    );
    await expect(dialog(o).locator(".modal-title")).toHaveText("Update the Geode server?");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
