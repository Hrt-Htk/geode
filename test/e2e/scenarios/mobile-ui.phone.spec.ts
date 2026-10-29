import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { runCommand } from "../helpers/palette";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import { openLogsSection } from "../helpers/logs";

// #173: on-device: the Logs section and the settings-button notices.

const PASSPHRASE = "phone-pass";

/** Remove any visible Notice toasts so they don't cover the screenshot. */
async function clearNotices(obsidian: { eval: (s: string) => Promise<unknown> }): Promise<void> {
  await obsidian.eval(`
    document.querySelectorAll('.notice').forEach((n) => n.remove());
    return true;
  `);
}

test("phone UI: Logs section + mobile Notices", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    keepStartupModal: true,
  });

  try {
    await expect.poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Logs section (Debug logging on) captured CLEAN (before any reconcile/lock) ---- */
    await openLogsSection(obsidian, true);
    await new Promise((r) => setTimeout(r, 400));

    /* Log-driven assertion: reconcile must run cleanly on-device: no [error]
       lines in the log box. This catches mobile-only reconcile crashes (e.g.
       the unbound adapter.list "queue" TypeError) that screenshots alone miss. */
    const logText = await obsidian.eval<string>(`
      const el = document.querySelector('[data-testid="geode-log-box"]');
      return el ? el.innerText : '';
    `);
    expect(logText, "Logs box should contain no [error] lines").not.toContain("[error]");

    await clearNotices(obsidian);
    await obsidian.eval(`
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 200));
    await obsidian.screenshot(shotPath("phone-debug-panel.png"));

    /* ---- Mobile status icon: lock the vault → icon reflects locked state ---- */
    await clearNotices(obsidian);
    await runCommand(obsidian.win, "Geode: Lock vault");
    await new Promise((r) => setTimeout(r, 800));
    await obsidian.win.locator('[data-testid="geode-mobile-status"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    const mobileStatusEl = obsidian.win.locator('[data-testid="geode-mobile-status"]');
    expect(await mobileStatusEl.getAttribute("class")).toContain("geode-statusbar-locked");
    await obsidian.screenshot(shotPath("phone-notice.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
