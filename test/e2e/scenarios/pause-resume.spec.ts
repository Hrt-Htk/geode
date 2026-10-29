import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { type E2EServer, type ProvisionedDevice, startServer } from "../fixtures/server";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #338: pause stops the transport + reconciler and gates the commit queue, so a
// local edit while paused is held and counted ("N changes waiting") but never
// uploaded; the pause persists across a plugin reload (key cache keeps the vault
// unlocked); resume reconnects and uploads the held edit. All settings-tab
// updates happen in place: the tab is never re-rendered.
//
// Heads snapshot: a fresh vault carries Obsidian onboarding files, so there is no
// fixed "1 head" baseline. The pause gate asserts the FULL server snapshot (path
// hash → version) stays byte-identical while paused; resume asserts a new version
// lands (heads?after_seq=baselineMaxSeq is non-empty).
const PASSPHRASE = "pause-resume-pass";

const PAUSE = '[data-testid="geode-settings-pause"]';
const BANNER = '[data-testid="geode-settings-pause-banner"]';
const RESUME = '[data-testid="geode-settings-resume"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
const STATUSBAR = '[data-testid="geode-statusbar"]';
const NOTE = "pause-me.md";

type Head = { path_hash: string; version: number; seq: number };

async function readHeadsRaw(
  server: E2EServer,
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
  server: E2EServer,
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

test("pause/resume: pause holds edits, survives reload, resume uploads", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("pause-resume");
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

    /* A tracked note to pause against: create it and wait until its v1 commit lands. */
    await upsertVaultFile(o, NOTE, "v1");
    await expect.poll(
      async () =>
        await o.eval<number>(
          `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
            JSON.stringify(NOTE)
          })?.last_seen_version ?? 0`,
        ),
      { timeout: 30_000 },
    ).toBe(1);
    const baseline = await waitForSettledHeads(server, device, 30_000);
    const baselineSeq = Math.max(0, ...parseHeads(baseline).map((h) => h.seq));

    /* Open the settings tab on the Geode tab and keep it open. */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const statusRow = o.win.locator(STATUS_ROW);
    await statusRow.waitFor({ timeout: 15_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 30_000,
      })
      .toMatch(/^Up to date\. Last backup /);

    /* Marker on the Status section: a full re-render would recreate it. */
    await o.eval(`
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const st = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Status"));
      if (!st) throw new Error("Status section not found");
      st.dataset.e2eMarker = "no-rerender";
      return true;
    `);
    const markerPresent = (): Promise<boolean> =>
      o.eval<boolean>(`!!document.querySelector('.geode-section[data-e2e-marker="no-rerender"]')`);

    const banner = o.win.locator(BANNER);
    const bannerName = banner.locator(".geode-banner-name");
    const bannerDesc = banner.locator(".setting-item-description");
    const statusbarEl = o.win.locator(STATUSBAR);

    /* ---- 1. Click [Pause]: banner appears, row shows pause copy, status-bar icon paused ---- */
    await o.win.locator(PAUSE).click();
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(bannerName).toHaveText("Sync paused");
    expect(await bannerDesc.textContent()).toMatch(/^paused (just now|\d+ (min|h) ago)$/);
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Paused\. Changes are kept locally and upload when you resume\.$/);
    await expect(statusbarEl).toHaveClass(/geode-statusbar-paused-grey/);
    expect(await statusbarEl.getAttribute("title")).toMatch(/^Sync paused\. /);

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("338-01-paused.png"),
    });
    expect(await markerPresent(), "marker must survive the pause click").toBe(true);

    /* ---- 2. Edit while paused: row counts it, the server sees no new version ---- */
    await upsertVaultFile(o, NOTE, "v2");
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

    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("338-02-paused-waiting.png"),
    });
    expect(await markerPresent(), "marker must survive the waiting-count update").toBe(true);

    /* ---- 3. Reload the plugin: pause persists, vault stays unlocked via key cache ---- */
    await o.eval(`
      app.setting?.close?.();
      await app.plugins.disablePlugin("geode");
      await app.plugins.enablePlugin("geode");
      return true;
    `);
    await waitForUnlocked(o, 60_000);
    await o.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    await banner.waitFor({ timeout: 15_000 });
    await expect(bannerName).toHaveText("Sync paused");
    await expect(statusbarEl).toHaveClass(/geode-statusbar-paused-grey/);
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Paused\. /);

    /* Re-arm the marker on the rebuilt tab; resume must not re-render it. */
    await o.eval(`
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const st = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Status"));
      if (!st) throw new Error("Status section not found");
      st.dataset.e2eMarker = "no-rerender";
      return true;
    `);
    expect(await markerPresent(), "marker must be present after reload + reopen").toBe(true);

    /* ---- 4. Banner [Resume]: banner gone, held edit uploads, row back to Up to date ---- */
    await o.win.locator(RESUME).click();
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
    await expect(statusbarEl).toHaveClass(/geode-statusbar-ok/);

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("338-03-resumed.png"),
    });
    expect(await markerPresent(), "marker must survive resume").toBe(true);

    /* Status bar returns to the synced tooltip. */
    await expect
      .poll(async () => await readGeodeStatusBar(o.win), { timeout: 15_000 })
      .toContain("Geode: synced");

    /* ---- 5. Lock while paused: the banner must not linger on a locked tab; unlock restores it ---- */
    await o.win.locator(PAUSE).click();
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-lock"]').click(); return true;`,
    );
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Locked\. /);

    /* Unlock via the real UI path (passphrase modal → plugin unlock): still paused, banner back. */
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-unlock"]').click(); return true;`,
    );
    const unlockModal = o.win.locator('.modal:has(:text("Unlock Geode"))');
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await unlockModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await unlockModal.locator('[data-testid="geode-passphrase-input"]').press("Enter");
    await expect(unlockModal).not.toBeVisible({ timeout: 15_000 });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(bannerName).toHaveText("Sync paused");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
