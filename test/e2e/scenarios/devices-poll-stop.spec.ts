import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";

// #502: the settings-tab Devices section (30s) and the Devices-view modal (5s) must stop
// polling /devices/status when their surface goes away: closing the settings tab, closing
// the modal, and a plugin disable/enable (BRAT reload) must each leave no live timer.
// The desktop plugin issues HTTP via Obsidian's requestUrl (main process), so the polls are
// counted at the network layer: a transparent proxy in front of the throwaway server that
// tallies /devices/status requests. Each test freezes the count once the surface is gone
// and asserts it stays frozen for longer than one full interval.

const PASSPHRASE = "poll-pass";
const SETTINGS_POLL_MS = 30_000;
const MODAL_POLL_MS = 5_000;

type PollCounter = { url: string; deviceStatusCount: () => number; close: () => Promise<void> };

function countingProxy(targetUrl: string): Promise<PollCounter> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    let count = 0;
    const srv = createHttpServer((req, res) => {
      if (req.url?.includes("/devices/status")) count++;
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    // This test never syncs; drop WS upgrades so the transport stays disconnected.
    srv.on("upgrade", (_req, socket) => socket.destroy());
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("counting proxy has no address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        deviceStatusCount: () => count,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

type Harness = { server: E2EServer; proxy: PollCounter; obsidian: ObsidianInstance };

async function launchConfigured(): Promise<Harness> {
  const server = await startServer();
  const proxy = await countingProxy(server.url);
  const device = await server.mintToken("poll");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: proxy.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });
  return { server, proxy, obsidian };
}

async function openSettingsTab(obsidian: ObsidianInstance): Promise<void> {
  await obsidian.eval(`app.setting.open(); app.setting.openTabById("geode"); return true;`);
  await obsidian.win
    .locator('[data-testid="geode-settings-devices-summary"]')
    .waitFor({ timeout: 15_000 });
}

async function closeSettingsTab(obsidian: ObsidianInstance): Promise<void> {
  await obsidian.eval(`app.setting.close(); return true;`);
}

test("settings tab close stops /devices/status polling", async () => {
  test.slow();
  const { server, proxy, obsidian } = await launchConfigured();
  try {
    await waitForUnlocked(obsidian);
    await openSettingsTab(obsidian);
    await expect.poll(() => proxy.deviceStatusCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(
      1,
    );
    await closeSettingsTab(obsidian);
    const frozen = proxy.deviceStatusCount();
    await new Promise((r) => setTimeout(r, SETTINGS_POLL_MS + 5_000));
    expect(proxy.deviceStatusCount()).toBe(frozen);
  } finally {
    await obsidian.close();
    await proxy.close();
    await server.stop();
  }
});

test("Devices modal close stops /devices/status polling", async () => {
  test.slow();
  const { server, proxy, obsidian } = await launchConfigured();
  try {
    await waitForUnlocked(obsidian);
    await openSettingsTab(obsidian);
    await obsidian.win.locator('[data-testid="geode-settings-devices-manage"]').click();
    await obsidian.win.locator('[data-testid="geode-devices-modal"]').waitFor({ timeout: 15_000 });
    await expect.poll(() => proxy.deviceStatusCount(), { timeout: 10_000 }).toBeGreaterThanOrEqual(
      2,
    );
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-devices-done"]').click(); app.setting.close(); return true;`,
    );
    const frozen = proxy.deviceStatusCount();
    await new Promise((r) => setTimeout(r, MODAL_POLL_MS * 2 + 2_000));
    expect(proxy.deviceStatusCount()).toBe(frozen);
  } finally {
    await obsidian.close();
    await proxy.close();
    await server.stop();
  }
});

test("plugin disable/enable leaves no /devices/status polling", async () => {
  test.slow();
  const { server, proxy, obsidian } = await launchConfigured();
  try {
    await waitForUnlocked(obsidian);
    await openSettingsTab(obsidian);
    await expect.poll(() => proxy.deviceStatusCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(
      1,
    );
    // BRAT-style reload: disable + re-enable the plugin while the tab is open.
    await obsidian.eval(`
      await app.plugins.disablePlugin("geode");
      await app.plugins.enablePlugin("geode");
      return true;
    `);
    // The re-enabled plugin re-registers its settings tab; if it is showing, close it so
    // only a leaked (stale) timer could still poll.
    await obsidian.eval(`
      if (!app.setting.containerEl.classList.contains("mod-hidden") && app.setting.activeTab?.id === "geode") {
        app.setting.close();
      }
      return true;
    `);
    const frozen = proxy.deviceStatusCount();
    await new Promise((r) => setTimeout(r, SETTINGS_POLL_MS + 5_000));
    expect(proxy.deviceStatusCount()).toBe(frozen);
  } finally {
    await obsidian.close();
    await proxy.close();
    await server.stop();
  }
});
