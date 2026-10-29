import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForPluginLoaded } from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { startOldServer } from "../helpers/old-server";
import { readGeodeStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #625: a server whose minimum plugin version is above this build must put the
// real plugin in `blocked` with an update prompt, and must NOT drive the
// reconnect loop that showed users an endless "disconnected". The whole flow is
// the production one: the server refuses the real handshake (min-version gate),
// the plugin reacts to the close.
const PASSPHRASE = "update-prompt-pass";
const NOTICE = "Geode needs an update to keep syncing. Update the plugin, then reload Obsidian.";
const SERVER_BEHIND_NOTICE =
  "The Geode server needs an update to keep syncing. Update the server, then reload Obsidian.";

test("issue625: a refused plugin version blocks with an update prompt and never reconnects", async () => {
  test.slow();

  const server = await startServer({ env: { GEODE_MIN_PLUGIN_VERSION: "99.0.0" } });
  const device = await server.mintToken("issue625");

  const obsidian = await launchObsidian({
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
    await waitForPluginLoaded(obsidian);
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* Count real socket constructions: one connect attempt, never a loop. */
    await obsidian.eval(`
      window.__geode625Sockets = 0;
      const OrigWebSocket = window.WebSocket;
      window.WebSocket = class extends OrigWebSocket {
        constructor(...args) {
          super(...args);
          window.__geode625Sockets++;
        }
      };
      return true;
    `);

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await obsidian.eval(`
      window.__geode625Reconnects = 0;
      app.plugins.plugins.geode.transport.addEventListener("reconnect", () => {
        window.__geode625Reconnects++;
      });
      return true;
    `);

    /* The server refuses the handshake → the plugin must land in blocked. */
    await expect.poll(
      async () => await obsidian.eval<string>("app.plugins.plugins.geode.transport.getState()"),
      { timeout: 30_000 },
    ).toBe("blocked");

    const notice = obsidian.win.locator(".notice").filter({
      hasText: "needs an update to keep syncing",
    });
    await expect(notice.first()).toBeVisible({ timeout: 10_000 });
    expect((await notice.first().textContent())?.trim()).toBe(NOTICE);

    const statusEl = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await expect(statusEl).toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    expect(await statusEl.getAttribute("title")).toBe("Geode: update the plugin to keep syncing");
    await obsidian.win.screenshot({ path: shotPath("625-blocked-notice.png") });

    /* No reconnect loop: the backoff would fire within ~1s, 2s, 4s. */
    await obsidian.win.waitForTimeout(6_000);
    expect(await obsidian.eval<number>("window.__geode625Sockets")).toBe(1);
    expect(await obsidian.eval<number>("window.__geode625Reconnects")).toBe(0);
    expect(await obsidian.eval<string>("app.plugins.plugins.geode.transport.getState()"))
      .toBe("blocked");

    /* Settings banner names the state and the fix, on one line. */
    await openSettingsTab(obsidian);
    const banner = obsidian.win.locator(".setting-item").filter({ hasText: "Update required" });
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });
    const bannerText = (await banner.first().textContent()) ?? "";
    expect(bannerText).toContain("Update the plugin, then reload Obsidian.");
    const descLines = await obsidian.eval<number>(`
      (() => {
        const desc = Array.from(document.querySelectorAll(".setting-item")).find((el) =>
          el.textContent.includes("Update required"))?.querySelector(".setting-item-description");
        if (!desc) return -1;
        const lh = parseFloat(getComputedStyle(desc).lineHeight) || 20;
        return desc.getBoundingClientRect().height / lh;
      })()
    `);
    expect(descLines).toBeGreaterThan(0);
    expect(descLines).toBeLessThan(1.6);
    const syncRow = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect
      .poll(async () => await syncRow.first().textContent(), { timeout: 10_000 })
      .toContain("Update the plugin to keep syncing.");
    await obsidian.win.screenshot({ path: shotPath("625-settings-update-banner.png") });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});

/* #625: the other side: an OLD server (one protocol behind) refuses this newer
   plugin. The refusal reason names both protocol numbers, so the copy must point
   at the server, not the plugin. The peer is helpers/old-server.deno.ts: an old
   server binary cannot be spawned from the current source. */
test("issue625: an old server that speaks a lower protocol asks for a server update", async () => {
  test.slow();

  const oldServer = await startOldServer();
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: oldServer.url,
      vaultId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceToken: "old-server-token",
      salt: "AAAAAAAAAAAAAAAAAAAAAA==",
    },
    keepStartupModal: true,
  });

  try {
    await waitForPluginLoaded(obsidian);
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await expect.poll(
      async () => await obsidian.eval<string>("app.plugins.plugins.geode.transport.getState()"),
      { timeout: 30_000 },
    ).toBe("blocked");
    expect(await obsidian.eval<string>("app.plugins.plugins.geode.versionStatus.side"))
      .toBe("server");

    const notice = obsidian.win.locator(".notice").filter({
      hasText: "The Geode server needs an update",
    });
    await expect(notice.first()).toBeVisible({ timeout: 10_000 });
    expect((await notice.first().textContent())?.trim()).toBe(SERVER_BEHIND_NOTICE);
    const statusEl = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await expect(statusEl).toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    expect(await statusEl.getAttribute("title"))
      .toBe("Geode: the server needs an update to keep syncing");
    await obsidian.win.screenshot({ path: shotPath("625-server-behind-notice.png") });

    await openSettingsTab(obsidian);
    const banner = obsidian.win.locator(".setting-item").filter({
      hasText: "Server update required",
    });
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });
    const bannerText = (await banner.first().textContent()) ?? "";
    expect(bannerText).toContain("Update the Geode server, then reload Obsidian.");
    const syncRow = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect
      .poll(async () => await syncRow.first().textContent(), { timeout: 10_000 })
      .toContain("Update the Geode server to keep syncing.");
    await obsidian.win.screenshot({ path: shotPath("625-server-behind-settings.png") });
  } finally {
    await obsidian.close();
    await oldServer.stop();
  }
});
