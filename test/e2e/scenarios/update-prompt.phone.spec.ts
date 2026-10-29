import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { openSettingsTab } from "../helpers/logs";
import { readGeodeStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #625 (phone): the desktop spec's on-device counterpart: a server whose
// minimum plugin version is above the installed build must show the update
// prompt and stop, not reconnect-loop. Needs the local throwaway server
// (GEODE_PHONE_HOST) because it starts with a raised minimum version.
const PASSPHRASE = "update-prompt-phone-pass";
const NOTICE = "Geode needs an update to keep syncing. Update the plugin, then reload Obsidian.";

test("issue625 update prompt (phone): refused plugin version blocks with the notice and no reconnect loop", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer({ env: { GEODE_MIN_PLUGIN_VERSION: "99.0.0" } });
  const device = await server.mintToken("update-prompt-phone");

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

    await expect.poll(
      async () => await obsidian.eval<string>("app.plugins.plugins.geode.transport.getState()"),
      { timeout: 30_000 },
    ).toBe("blocked");

    /* The update notice is on screen, and the mobile status icon carries the tooltip. */
    const notices = await obsidian.eval<string[]>(
      `Array.from(document.querySelectorAll(".notice")).map((n) => (n.textContent || "").trim())`,
    );
    expect(notices).toContain(NOTICE);
    const mobileStatus = obsidian.win.locator('[data-testid="geode-mobile-status"]');
    await expect(mobileStatus).toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    expect(await mobileStatus.first().getAttribute("aria-label"))
      .toBe("Geode: update the plugin to keep syncing");

    /* No reconnect loop: one socket, zero reconnect events, still blocked. */
    await obsidian.eval(`new Promise((r) => setTimeout(r, 6000)); return true;`);
    expect(await obsidian.eval<number>("window.__geode625Sockets")).toBe(1);
    expect(await obsidian.eval<number>("window.__geode625Reconnects")).toBe(0);
    expect(await obsidian.eval<string>("app.plugins.plugins.geode.transport.getState()"))
      .toBe("blocked");

    /* Keep only the newest matching notice in the shot. The harness reloads the
       plugin and then locks it (clearing the one-off guard), so a real second
       block after our unlock legitimately stacks a second notice. */
    await obsidian.eval(`
      const all = Array.from(document.querySelectorAll(".notice"));
      const matching = all.filter((n) => (n.textContent || "").includes("needs an update to keep syncing"));
      all.forEach((n) => { if (n !== matching[matching.length - 1]) n.remove(); });
      return true;
    `);
    await obsidian.screenshot(shotPath("625-phone-blocked-notice.png"));

    /* Settings banner, opened the mobile way (no leading close). */
    await openSettingsTab(obsidian, true);
    const banner = obsidian.win.locator(".setting-item").filter({ hasText: "Update required" });
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });
    expect((await banner.first().textContent()) ?? "")
      .toContain("Update the plugin, then reload Obsidian.");
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("625-phone-settings-update-banner.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
