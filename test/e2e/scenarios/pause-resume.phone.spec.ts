import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { type RemoteServer, useRemoteServer } from "../fixtures/phone-server";
import type { ProvisionedDevice } from "../fixtures/server";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #338 (phone): mirrors the desktop #338 flow on the real device: pause from
// the settings status row, the "Sync paused" banner + paused status copy appear,
// a local edit while paused is held ("1 change waiting") and never uploaded, and
// banner [Resume] uploads it. Mobile patterns: settings open without a leading
// app.setting.close(), in-page eval clicks, adb screencap for the shot.
//
// Heads snapshot: the persistent test vault carries other tracked files, so there
// is no fixed "1 head" baseline: the pause gate asserts the full server snapshot
// stays byte-identical while paused; resume asserts a new version lands.
const PASSPHRASE = "pause-resume-phone-pass";

const PAUSE = '[data-testid="geode-settings-pause"]';
const BANNER = '[data-testid="geode-settings-pause-banner"]';
const RESUME = '[data-testid="geode-settings-resume"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
const STATUSBAR = '[data-testid="geode-statusbar"]';
const NOTE = "pause-phone.md";

type Head = { path_hash: string; version: number; seq: number };

async function readHeadsRaw(
  server: RemoteServer,
  device: ProvisionedDevice,
  afterSeq?: number,
): Promise<string> {
  const suffix = afterSeq === undefined ? "" : `?after_seq=${afterSeq}`;
  const res = await fetch(`${server.url}/vaults/${server.vaultId}/heads${suffix}`, {
    headers: { authorization: `Bearer ${device.token}` },
  });
  if (!res.ok) throw new Error(`heads fetch failed: ${res.status}`);
  return res.text();
}

function parseHeads(raw: string): Head[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Head);
}

/** Wait until two reads 1.5 s apart return the same full heads snapshot (no in-flight commits). */
async function waitForSettledHeads(
  server: RemoteServer,
  device: ProvisionedDevice,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  let prev: string | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const cur = await readHeadsRaw(server, device);
    if (prev !== null && cur === prev) return cur;
    prev = cur;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error("timed out waiting for the server heads snapshot to settle");
}

test("pause/resume (phone): pause → banner → resume", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("pause-resume-phone");

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

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* A tracked note to pause against: create it and wait until its v1 commit lands. */
    await upsertVaultFile(obsidian, NOTE, "v1");
    await expect.poll(
      async () =>
        await obsidian.eval<number>(
          `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
            JSON.stringify(NOTE)
          })?.last_seen_version ?? 0`,
        ),
      { timeout: 60_000 },
    ).toBe(1);
    const baseline = await waitForSettledHeads(server, device, 30_000);
    const baselineSeq = Math.max(0, ...parseHeads(baseline).map((h) => h.seq));

    /* Open the settings tab (no leading app.setting.close() on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const statusRow = obsidian.win.locator(STATUS_ROW);
    await statusRow.waitFor({ timeout: 15_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 30_000,
      })
      .toMatch(/^Up to date\. Last backup /);

    const banner = obsidian.win.locator(BANNER);
    const bannerName = banner.locator(".geode-banner-name");
    const bannerDesc = banner.locator(".setting-item-description");
    const statusbarEl = obsidian.win.locator(STATUSBAR);

    /* ---- Pause from the status row: banner + paused copy + paused status-bar icon ---- */
    await evalClick(obsidian, PAUSE);
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(bannerName).toHaveText("Sync paused");
    expect(await bannerDesc.textContent()).toMatch(/^paused (just now|\d+ (min|h) ago)$/);
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Paused\. /);
    await expect(statusbarEl).toHaveClass(/geode-statusbar-paused-grey/);

    /* ---- Edit while paused: held and counted, server sees no new version ---- */
    await upsertVaultFile(obsidian, NOTE, "v2");
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/1 change waiting/);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await readHeadsRaw(server, device), `heads snapshot unchanged (poll ${i})`).toBe(
        baseline,
      );
    }

    /* On-device screenshot of the paused settings tab. */
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("338-phone-01-paused.png"));

    /* ---- Banner [Resume]: held edit uploads, row back to Up to date ---- */
    await evalClick(obsidian, RESUME);
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(
      async () => (await readHeadsRaw(server, device, baselineSeq)).trim().length > 0,
      { timeout: 60_000 },
    ).toBe(true);
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 60_000,
      })
      .toMatch(/^Up to date\. Last backup /);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
