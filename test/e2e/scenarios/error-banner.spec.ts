import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #339: the settings tab shows a degraded-sync banner: "Cannot reach your
// Geode server" after ~10 s offline (with [Retry] that reconnects now) and
// "Some changes couldn't upload" while commits are dropped. The banner updates
// in place: the tab is never re-rendered.
const PASSPHRASE = "error-banner-pass";

const BANNER = '[data-testid="geode-settings-error-banner"]';
const RETRY = '[data-testid="geode-settings-error-retry"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';

test("error banner: unreachable → retry → recovered → dropped variant, no re-render", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("error-banner");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

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

    /* ---- 1. Synced: no error banner ---- */
    await expect(banner).toHaveCount(0);

    /* ---- 2. Server unreachable: banner appears within ~25 s ---- */
    await server.shutdown();
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(bannerName).toHaveText("Cannot reach your Geode server");
    expect(await bannerDesc.textContent()).toMatch(
      /^Sync is paused until 127\.0\.0\.1:\d+ is reachable\. Last attempt /,
    );
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 15_000,
      })
      .toMatch(/^Offline\. Retrying in \d+ s\./);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("339-01-unreachable.png"),
    });

    /* ---- 3. Server back + [Retry]: banner gone, status row recovered ---- */
    await server.restart();
    await o.win.locator(RETRY).click();
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => await statusRow.locator(".setting-item-description").textContent(), {
        timeout: 60_000,
      })
      .toMatch(/^Up to date\. Last backup /);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("339-02-recovered.png"),
    });

    /* ---- 4. Dropped variant (UI only): banner shows the dropped count ---- */
    await o.eval(`app.plugins.plugins.geode.statusBar.updateDropped(2); return true;`);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(bannerName).toHaveText("Some changes couldn't upload");
    expect(await bannerDesc.textContent()).toMatch(/^2 files failed to upload/);
    await expect(o.win.locator(`${STATUS_ROW} .setting-item-description`))
      .toHaveText(/^2 changes couldn't upload\. Last backup /);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("339-03-dropped.png"),
    });

    await o.eval(`app.plugins.plugins.geode.statusBar.updateDropped(0); return true;`);
    await expect(banner).toHaveCount(0, { timeout: 10_000 });

    /* The tab was not re-rendered at any point. */
    expect(await markerPresent(), "Status section marker must survive all banner updates").toBe(
      true,
    );
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
