import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";

// #135: the status bar's last-synced time refreshes without a reopen.

const PASSPHRASE = "liverefresh-passphrase";

test("status bar shows icon with tooltip containing last synced time", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("liverefresh-statusbar");

  const obsidian = await launchObsidian({
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
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Tooltip contains synced state + last synced time. */
    const tooltip = await readGeodeStatusBar(obsidian.win);
    expect(tooltip).toMatch(/^Geode: synced · Last synced: \d+[smh] ago$/);

    await obsidian.win.screenshot({ path: shotPath("live-refresh-statusbar.png") });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});

test("debug pane Status section updates without reopening", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("liverefresh-pane");

  const obsidian = await launchObsidian({
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
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Open the Logs section (settings tab, after Advanced). */
    await obsidian.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const logs = sections.find((s) =>
        s.querySelector(".setting-item-heading")?.textContent?.trim() === "Logs");
      if (logs) logs.querySelector(".geode-collapsible-heading")?.click();
      return true;
    `);
    await expect(obsidian.win.locator('[data-testid="geode-log-box"]')).toBeVisible({
      timeout: 15_000,
    });

    /* Read the details line: should start with the connected state. */
    const liveText = await obsidian.eval<string>(
      `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
    );
    expect(liveText).toMatch(/^Connected · seq \d+ · \d+ pending$/);

    /* Screenshot the Logs section scrolled into view. */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("live-refresh-pane-live.png"),
    });

    /* Shutdown the server: do NOT close/reopen the section. */
    await server.shutdown();

    /* Poll the SAME open section until the details line no longer starts with
       the connected state ("Disconnected" contains "Connected", so match the start). */
    await expect
      .poll(
        async () =>
          await obsidian.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 30_000 },
      )
      .not.toMatch(/^Connected ·/);

    /* Screenshot the Logs section scrolled into view. */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("live-refresh-pane-offline.png"),
    });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
