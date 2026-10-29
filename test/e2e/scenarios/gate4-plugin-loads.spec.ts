import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForStatusBar } from "../helpers/waits";

test("gate4 plugin loads against real Obsidian", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("gate4-plugin-loads");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    const pluginAppeared = await obsidian.win.waitForFunction(
      () => Boolean((window as any).app?.plugins?.plugins?.geode),
      undefined,
      { timeout: 60_000 },
    ).then(() => true).catch(() => false);

    if (!pluginAppeared) {
      const diagnostics = await obsidian.eval<{
        manifests: string[];
        enabled: string[];
        loaded: string[];
        safeMode: unknown;
        modalText: string;
      }>(`({
        manifests: Object.keys(app.plugins.manifests ?? {}),
        enabled: Array.from(app.plugins.enabledPlugins ?? []),
        loaded: Object.keys(app.plugins.plugins ?? {}),
        safeMode: app.plugins.safeMode,
        modalText: document.body.innerText.slice(0, 2000)
      })`);
      throw new Error(
        `Geode plugin did not load: ${
          JSON.stringify({
            diagnostics,
            consoleErrors: obsidian.consoleErrors(),
          })
        }`,
      );
    }

    const pluginLoaded = await obsidian.eval<boolean>("Boolean(app.plugins.plugins.geode)");
    expect(pluginLoaded).toBe(true);

    const statusText = await waitForStatusBar(obsidian.win, "Geode");
    expect(statusText).toContain("Geode");

    expect(obsidian.consoleErrors()).toEqual([]);
  } finally {
    await obsidian.close();
    await server.stop();
  }
});
