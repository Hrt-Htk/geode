import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { expandLogsSection, openSettingsTab } from "../helpers/logs";
import { dismissModals } from "../helpers/mobile-ui";
import {
  closeSettingsPage,
  DEVELOPER_CONSOLE_ROW,
  openSettingsPage,
  rowShown,
  setRowControl,
  shownSections,
} from "../helpers/settings-tab";

const PASSPHRASE = "logs-pass";

// #434/#453/#64: the Logs section on the phone: a page entry after Advanced while the vault is
// unlocked, without any setting; the log box keeps its fixed height and scrolls; the Developer
// console toggle is its last row. Screenshot gate on-device.
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

    /* ---- #64: Logs is a page entry while unlocked, with Developer console off ---- */
    const debugLogging = () =>
      o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.debugLogging`);
    await openSettingsPage(o, "Logs");
    if (await debugLogging()) await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    expect(await debugLogging(), "Developer console off for the #64 shot").toBe(false);
    await closeSettingsPage(o);
    expect(await shownSections(o), "Logs last, without any setting").toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced", "Logs"],
    );
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      const pane = document.querySelector(".modal.mod-settings .vertical-tab-content") ??
        document.querySelector(".modal.mod-settings .modal-content");
      if (pane) pane.scrollTop = pane.scrollHeight;
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    await o.screenshot(shotPath("64-phone-00-nav-logs-entry.png"));

    await expandLogsSection(o);
    expect(
      await rowShown(o, DEVELOPER_CONSOLE_ROW),
      "Developer console is a row of the Logs page",
    ).toBe(true);

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
      [...document.querySelectorAll(".modal.mod-settings .setting-item")]
        .find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() ===
          ${JSON.stringify(DEVELOPER_CONSOLE_ROW)})
        ?.scrollIntoView({ block: "end" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    await o.screenshot(shotPath("64-phone-01-logs-developer-console.png"));

    /* Advanced no longer carries the toggle: shoot it where the row used to sit. */
    await closeSettingsPage(o);
    await openSettingsPage(o, "Advanced");
    expect(await rowShown(o, DEVELOPER_CONSOLE_ROW), "Advanced is free of it").toBe(false);
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      [...document.querySelectorAll(".modal.mod-settings .setting-item-name")]
        .find((e) => e.textContent.trim() === "Resync from scratch")?.scrollIntoView({ block: "center" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    await o.screenshot(shotPath("64-phone-02-advanced.png"));

    /* Errors filter works on-device (a real error is generated first via the
       misconfigured-vault path: empty salt → unlockVault logs "no salt configured"). */
    await closeSettingsPage(o);
    await openSettingsPage(o, "Logs");
    await o.eval(`
      const geode = app.plugins.plugins.geode;
      const saved = geode.pluginSettings.salt;
      geode.pluginSettings.salt = "";
      await geode.unlockVault("anything");
      geode.pluginSettings.salt = saved;
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
