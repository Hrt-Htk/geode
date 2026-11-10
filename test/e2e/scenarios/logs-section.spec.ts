import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection, openSettingsTab } from "../helpers/logs";
import {
  closeSettingsPage,
  DEVELOPER_CONSOLE_ROW,
  isDisplayPath,
  openSettingsPage,
  rowShown,
  setRowControl,
  shownSections,
  useDisplayPath,
} from "../helpers/settings-tab";

// #434/#453/#64: the Logs section replaced the right-sidebar debug pane. It is a sub-page after
// Advanced on Obsidian 1.13+ (#16) and shows while the vault is unlocked, without any setting
// (#64): sync details line with real values, All / Warnings / Errors filter tabs, a fixed-height
// scrollable monospace log box fed by the real ring buffer, Copy logs, and last the Developer
// console toggle (the console mirror only). Screenshot gate: the page with real lines, Errors
// filter, the Developer console row.

const PASSPHRASE = "logs-pass";

test("logs section: reachable without a setting, real details/log, filters, Developer console", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("logs");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: false,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openSettingsTab(o);

    /* ---- 1. Logs sits last, a page entry while unlocked, with Developer console off (#64) ---- */
    expect(await shownSections(o), "section order with Logs last").toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced", "Logs"],
    );
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      [...document.querySelectorAll(".modal.mod-settings .setting-item-name")]
        .find((e) => e.textContent.trim() === "Logs")?.scrollIntoView({ block: "end" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".modal.mod-settings").screenshot({
      path: shotPath("64-00-nav-logs-entry.png"),
    });

    /* ---- 1.5. Advanced no longer carries the toggle (#64) ---- */
    await openSettingsPage(o, "Advanced");
    expect(await rowShown(o, DEVELOPER_CONSOLE_ROW), "Advanced is free of it").toBe(false);
    await closeSettingsPage(o);

    /* ---- 2. Open: real details line, filter tabs, log box with ring lines ---- */
    await openSettingsPage(o, "Logs");
    await expect(o.win.locator('[data-testid="geode-log-box"]')).toBeVisible({ timeout: 10_000 });

    const details = o.win.locator('[data-testid="geode-log-details"]');
    await expect
      .poll(async () => (await details.textContent()) ?? "", { timeout: 15_000 })
      .toMatch(/^Connected · seq \d+ · \d+ pending$/);

    const lines = o.win.locator('[data-testid="geode-log-box"] .geode-log-line');
    await expect.poll(async () => await lines.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).toHaveClass(/is-active/);
    await expect(o.win.locator('[data-testid="geode-log-filter-warn"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-log-filter-error"]')).toBeVisible();

    /* ---- Screenshot 1: expanded with real lines (All filter), scrolled into view ---- */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".modal.mod-settings").screenshot({
      path: shotPath("434-01-logs-expanded.png"),
    });

    /* ---- 3. Errors filter shows only error lines ---- */
    // Generate a REAL error through the misconfigured-vault path (empty salt →
    // unlockVault logs "no salt configured") so the Errors view has content.
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

    await o.win.locator('[data-testid="geode-log-filter-error"]').click();
    await expect(o.win.locator('[data-testid="geode-log-filter-error"]')).toHaveClass(/is-active/);
    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).not.toHaveClass(
      /is-active/,
    );
    await expect.poll(async () => await lines.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const classes = await o.win.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line'))
        .map((l) => l.className)
    );
    for (const c of classes) {
      expect(c, "every filtered line is an error line").toContain("geode-log-error");
    }

    /* ---- Screenshot 2: Errors filter ---- */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".modal.mod-settings").screenshot({
      path: shotPath("434-02-logs-errors.png"),
    });

    /* ---- 4. Developer console: last row of the page, and it only mirrors the console (#64) ---- */
    const debugLogging = () =>
      o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.debugLogging`);
    expect(await debugLogging(), "off by default").toBe(false);
    const lastRow = await o.eval<string>(`(() => {
      const rows = [...document.querySelectorAll(".modal.mod-settings .setting-item")]
        .filter((r) => r.offsetParent !== null);
      return rows.at(-1)?.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
    })()`);
    expect(lastRow, "Developer console is the last row of the page").toBe(DEVELOPER_CONSOLE_ROW);

    /* ---- Screenshot 3: the page bottom, Developer console off (#64) ---- */
    await o.win.locator('[data-testid="geode-log-filter-all"]').click();
    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).toHaveClass(/is-active/);
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      const row = [...document.querySelectorAll(".modal.mod-settings .setting-item")]
        .find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() ===
          ${JSON.stringify(DEVELOPER_CONSOLE_ROW)});
      row?.scrollIntoView({ block: "end" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".modal.mod-settings").screenshot({
      path: shotPath("64-03-developer-console.png"),
    });

    // The log view is one render row: a toggle that re-rendered the page would replace the box
    // and drop its live subscription, and every line logged afterwards would be lost.
    const boxKept = () =>
      o.eval<boolean>(
        `!!document.querySelector('[data-testid="geode-log-box"][data-e2e-marker="kept"]')`,
      );
    await o.eval(`(() => {
      document.querySelector('[data-testid="geode-log-box"]').dataset.e2eMarker = "kept";
      return true;
    })()`);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(true);
    expect(await boxKept(), "the log view survives the toggle").toBe(true);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(false);
    expect(await boxKept(), "still the same, still live").toBe(true);

    // The kept view still streams the ring (live append).
    const countBefore = await lines.count();
    await o.eval(`
      await app.vault.create("note.md", "# gate434\\ntest\\n");
      return true;
    `);
    await expect
      .poll(async () => await lines.count(), { timeout: 15_000 })
      .toBeGreaterThan(countBefore);

    /* ---- 5. display() (Obsidian < 1.13): the Logs section shows, and the toggle keeps it ---- */
    await closeSettingsPage(o);
    await useDisplayPath(o);
    await expect.poll(() => isDisplayPath(o)).toBe(true);
    await openSettingsPage(o, "Logs");
    const logsSectionShown = () =>
      o.eval<boolean>(`(() => {
        const heading = [...document.querySelectorAll(
          ".modal.mod-settings .geode-collapsible-heading"
        )].find((h) => h.textContent.trim() === "Logs");
        return !!heading && heading.offsetParent !== null;
      })()`);
    expect(await logsSectionShown(), "Logs section shown while unlocked").toBe(true);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(true);
    expect(await logsSectionShown(), "display(): the toggle never hides the section").toBe(true);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(false);
    await useDisplayPath(o, false);
    await expect.poll(() => isDisplayPath(o)).toBe(false);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("blocked transport shows Blocked in the log details line", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("blocked");
  const o = await launchObsidian({
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
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openLogsSection(o);

    /* Details line starts with the connected state. */
    await expect
      .poll(
        async () =>
          await o.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^Connected · seq \d+ · \d+ pending$/);

    /* Drive the real blocked state the server_version_mismatch message produces:
       transport.blocked + the session's onBlocked handler. getTransportState()
       must then report "blocked" and the details line must render Blocked. */
    await o.eval(`
      const geode = app.plugins.plugins.geode;
      geode.transport.blocked = true;
      geode.onBlocked("9.9.9", "0.0.1");
      return true;
    `);

    await expect
      .poll(
        async () =>
          await o.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^Blocked · seq \d+ · \d+ pending$/);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
