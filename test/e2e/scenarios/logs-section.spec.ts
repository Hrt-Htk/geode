import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection, openSettingsTab } from "../helpers/logs";
import {
  closeSettingsPage,
  DEBUG_LOGGING_ROW,
  isDisplayPath,
  markNoRerender,
  openSettingsPage,
  readScroll,
  rowShown,
  setRowControl,
  shownSections,
  useDisplayPath,
} from "../helpers/settings-tab";

// #434/#453: the Logs section replaced the right-sidebar debug pane. Debug
// logging on shows the Logs rows (a sub-page after Advanced on Obsidian 1.13+, #16):
// sync details line with real values, All / Warnings / Errors filter tabs, a
// fixed-height scrollable monospace log box fed by the real ring buffer, Copy logs.
// Debug logging off hides the Logs entry in place; on brings it back, still live.
// Screenshot gate: the page with real lines, Errors filter, off.

const PASSPHRASE = "logs-pass";

test("logs section: real details/log, filters, in-place toggle, no re-render", async () => {
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
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openSettingsTab(o);

    /* ---- 1. Logs sits after Advanced, a page entry while Debug logging is on ---- */
    expect(await shownSections(o), "section order with Logs last").toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced", "Logs"],
    );

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

    /* ---- 4. Debug logging off hides the Logs entry in place; on brings it back ---- */
    await closeSettingsPage(o);
    await openSettingsPage(o, "Advanced");
    await setRowControl(o, DEBUG_LOGGING_ROW);
    await closeSettingsPage(o);
    await expect.poll(() => rowShown(o, "Logs"), { timeout: 10_000 }).toBe(false);
    expect(await shownSections(o)).toEqual(["Vault", "Devices", "Sync scope", "Trash", "Advanced"]);

    /* ---- Screenshot 3: Debug logging off = no Logs entry ---- */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      [...document.querySelectorAll(".modal.mod-settings .setting-item-name")]
        .find((e) => e.textContent.trim() === "Advanced")?.scrollIntoView({ block: "end" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".modal.mod-settings").screenshot({
      path: shotPath("434-03-debug-off.png"),
    });

    await openSettingsPage(o, "Advanced");
    await setRowControl(o, DEBUG_LOGGING_ROW);
    await closeSettingsPage(o);
    await expect.poll(() => rowShown(o, "Logs"), { timeout: 10_000 }).toBe(true);
    await openSettingsPage(o, "Logs");
    await expect(o.win.locator('[data-testid="geode-log-box"]')).toBeVisible({ timeout: 10_000 });

    // The Errors filter survives a hide/show of the section (same view instance), so go back
    // to All before asserting the ring streams into the box again.
    await o.win.locator('[data-testid="geode-log-filter-all"]').click();
    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).toHaveClass(/is-active/);

    // The re-added section still streams the ring (live append).
    const countBefore = await lines.count();
    await o.eval(`
      await app.vault.create("note.md", "# gate434\\ntest\\n");
      return true;
    `);
    await expect
      .poll(async () => await lines.count(), { timeout: 15_000 })
      .toBeGreaterThan(countBefore);

    /* ---- 5. display() hides and re-shows the section in place: no tab re-render ---- */
    // Obsidian < 1.13 renders this whole tab through display(), where a re-render would wipe and
    // rebuild every row. The marker on the sync-status dot survives only an in-place update.
    await closeSettingsPage(o);
    await useDisplayPath(o);
    await expect.poll(() => isDisplayPath(o)).toBe(true);
    await openSettingsPage(o, "Advanced");
    // On this path Logs is a collapsible section (a heading), not a page entry.
    const logsSectionShown = () =>
      o.eval<boolean>(`(() => {
        const heading = [...document.querySelectorAll(
          ".modal.mod-settings .geode-collapsible-heading"
        )].find((h) => h.textContent.trim() === "Logs");
        return !!heading && heading.offsetParent !== null;
      })()`);
    expect(await logsSectionShown(), "Logs section shown while Debug logging is on").toBe(true);
    // One flip first: clicking a control focuses it, which scrolls the row into view, and the
    // re-added section moves the pane the way browser scroll anchoring keeps the last content
    // still. Neither is a re-render: what a re-render destroys is the marker (display() rebuilds
    // every row) and the pane's depth (it would land back at the top).
    await setRowControl(o, DEBUG_LOGGING_ROW);
    await expect.poll(logsSectionShown, { timeout: 10_000 }).toBe(false);
    const markerPresent = await markNoRerender(o);
    const deepInTab = 1000;
    expect(await readScroll(o), "the pane sits deep in the tab").toBeGreaterThan(deepInTab);
    await setRowControl(o, DEBUG_LOGGING_ROW);
    await expect.poll(logsSectionShown, { timeout: 10_000 }).toBe(true);
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    expect(await readScroll(o), "Debug logging on: still in place").toBeGreaterThan(deepInTab);
    await setRowControl(o, DEBUG_LOGGING_ROW);
    await expect.poll(logsSectionShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    expect(await readScroll(o), "Debug logging off: still in place").toBeGreaterThan(deepInTab);
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
