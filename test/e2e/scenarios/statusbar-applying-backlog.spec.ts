import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

/**
 * #319: the desktop status bar must render the cold-sync apply backlog as an
 * "applying N/M" spinner, not a false "synced" checkmark. The real drain path
 * is proven on-device (cold-sync-progress.hybrid); this captures the
 * desktop visual by driving the same StatusBar state the drain produces.
 */
test("desktop status bar shows applying spinner (#319)", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("applying-shot");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: "applying-statusbar-pass",
  });
  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    // Drive the StatusBar into the mid-drain state the flushReplayBuffer emit
    // produces: transport live + syncingProgress current<total (main.ts maps
    // the "applying" status to updateSyncingProgress).
    const title = await o.eval<string>(`
      const sb = app.plugins.plugins.geode.statusBar;
      sb.updateState("live");
      sb.updateSyncingProgress(3, 7);
      const el = document.querySelector('[data-testid="geode-statusbar"]');
      return el.getAttribute("title") ?? el.getAttribute("aria-label") ?? "";
    `);
    expect(title).toBe("Geode: applying 3/7");

    // Assert the spinner class is applied (the visual cue), then capture.
    expect(
      await o.eval<boolean>(
        `document.querySelector('[data-testid="geode-statusbar"]').classList.contains("geode-statusbar-spin")`,
      ),
    ).toBe(true);

    await o.eval(`app.setting?.close?.(); return true;`);
    await o.win.keyboard.press("Escape").catch(() => {});
    const el = o.win.locator('[data-testid="geode-statusbar"]');
    await el.screenshot({ path: shotPath("statusbar-applying-backlog.png") }).catch(async () => {
      await o.win.screenshot({ path: shotPath("statusbar-applying-backlog.png") });
    });
  } finally {
    await o.close();
    await server.stop?.();
  }
});
