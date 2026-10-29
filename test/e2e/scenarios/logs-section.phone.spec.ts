import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { expandLogsSection, openSettingsTab } from "../helpers/logs";
import { dismissModals } from "../helpers/mobile-ui";

const PASSPHRASE = "logs-pass";

// #434/#453: the Logs section on the phone: same section after Advanced, the
// log box keeps its fixed height and scrolls. Screenshot gate on-device.

test("logs section on phone: fixed-height box, real lines, scrollable", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("phone-logs");
  const o = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
  });

  try {
    await o.eval(`await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`);
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    // Phone specs share the running Obsidian instance: a modal a prior spec
    // left open would cover the settings tab in the screenshot. Clear it first.
    await dismissModals(o);

    await openSettingsTab(o, true);
    await expandLogsSection(o);

    /* Real details line with the transport's live state. */
    await expect
      .poll(
        async () =>
          await o.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^Connected · seq \d+ · \d+ pending$/);

    /* Log box has real lines and a fixed height that scrolls. */
    await expect
      .poll(
        async () =>
          await o.eval<number>(
            `document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line').length`,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    const boxHeight = await o.eval<number>(
      `document.querySelector('[data-testid="geode-log-box"]')?.clientHeight ?? 0`,
    );
    expect(boxHeight, "log box keeps its fixed 220 px height on the phone").toBeGreaterThanOrEqual(
      200,
    );

    /* Screenshot: Logs expanded on-device, notices cleared. */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    await o.screenshot(shotPath("434-04-phone-logs.png"));

    /* Errors filter works on-device (a real error is generated first via the
       misconfigured-vault path: empty salt → unlockVault logs "no salt configured"). */
    await o.eval(`
      const geode = app.plugins.plugins.geode;
      const saved = geode.settings.salt;
      geode.settings.salt = "";
      await geode.unlockVault("anything");
      geode.settings.salt = saved;
      return true;
    `);
    await expect
      .poll(
        async () =>
          await o.eval<boolean>(
            `app.plugins.plugins.geode.getRecentLog().some((e) => e.level === "error")`,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await o.eval(
      `document.querySelector('[data-testid="geode-log-filter-error"]').click(); return true;`,
    );
    await expect
      .poll(
        async () =>
          await o.eval<number>(
            `document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line').length`,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    const classes = await o.eval<string[]>(
      `Array.from(document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line')).map((l) => l.className)`,
    );
    for (const c of classes) {
      expect(c, "every filtered line is an error line").toContain("geode-log-error");
    }
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
