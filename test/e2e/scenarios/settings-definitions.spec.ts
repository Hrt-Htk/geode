import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openSettingsTab } from "../helpers/logs";
import {
  AUTO_LOCK_ROW,
  clearNotices,
  closeSettingsPage,
  DEVELOPER_CONSOLE_ROW,
  expectSameRows,
  isDisplayPath,
  openSettingsPage,
  readRowControl,
  rowInventory,
  rowShown,
  scrollToHeading,
  searchSettings,
  setRowControl,
  SYNC_CONFIG_ROW,
  TRASH_RETENTION_ROW,
  useDisplayPath,
} from "../helpers/settings-tab";

// #16: Obsidian 1.13+ renders the Geode tab from getSettingDefinitions() (status block,
// Vault/Devices/Sync scope/Trash groups, Advanced and Logs sub-pages) and indexes it for
// settings search; display() renders the same rows for Obsidian < 1.13. One run drives both
// paths on the installed Obsidian and asserts the same rows and testids, so they cannot drift.

const PASSPHRASE = "settings-definitions-pass";
const WHOLE_NUMBER_COPY = "Enter a whole number, 1 or more.";

test("settings tab: definitions and display() render the same rows; search finds Geode", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("settings-definitions");
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
    await o.win.setViewportSize({ width: 1200, height: 900 }).catch(() => {});
    const modal = o.win.locator(".modal.mod-settings");
    const shot = async (name: string) => {
      await o.win.waitForTimeout(500);
      await clearNotices(o);
      await modal.screenshot({ path: shotPath(name) });
    };

    /* ---- Definitions path (Obsidian 1.13+) ---- */
    await openSettingsTab(o);
    expect(await isDisplayPath(o), "1.13+ renders from definitions").toBe(false);
    await expect.poll(() =>
      o.eval<string[]>(
        `[...document.querySelectorAll(".modal.mod-settings .setting-group .setting-item-heading")].map((h) => h.textContent.trim())`,
      )
    ).toEqual(["Vault", "Devices", "Sync scope", "Trash"]);
    expect(await rowShown(o, "Advanced"), "Advanced is a page entry").toBe(true);
    expect(await rowShown(o, "Logs"), "Logs is a page entry while unlocked (#64)").toBe(true);
    await o.win.waitForTimeout(1000);
    await shot("defs-01-top.png");
    for (const [i, group] of ["Vault", "Devices", "Sync scope", "Trash"].entries()) {
      // The Trash group is the last one: at the full window height the pane clamps at its bottom
      // and the frame repeats the Sync scope shot, so shoot it in a shorter window.
      const trash = group === "Trash";
      if (trash) await o.win.setViewportSize({ width: 1200, height: 560 });
      expect(await scrollToHeading(o, group)).toBe(true);
      await shot(`defs-0${i + 2}-${group.toLowerCase().replace(" ", "-")}.png`);
      if (trash) await o.win.setViewportSize({ width: 1200, height: 900 });
    }
    const defsMain = await rowInventory(o);
    await openSettingsPage(o, "Advanced");
    await shot("defs-06-advanced.png");
    const defsAdvanced = await rowInventory(o);
    await closeSettingsPage(o);
    await openSettingsPage(o, "Logs");
    await shot("defs-07-logs.png");
    const defsLogs = await rowInventory(o);
    await closeSettingsPage(o);

    /* Real controls write Geode's settings (and their side effects) through setControlValue. */
    await setRowControl(o, TRASH_RETENTION_ROW, "45");
    await expect.poll(() =>
      o.eval<number>(`app.plugins.plugins.geode.pluginSettings.trashRetentionDays`)
    )
      .toBe(45);
    await setRowControl(o, AUTO_LOCK_ROW, "0");
    await o.win.waitForTimeout(300);
    expect(
      await o.eval<number>(`app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours`),
      "0 is rejected",
    )
      .toBe(24);
    expect(await readRowControl(o, SYNC_CONFIG_ROW)).toBe("on");
    expect(await rowShown(o, "Config to sync")).toBe(true);
    await setRowControl(o, SYNC_CONFIG_ROW);
    await expect.poll(() => rowShown(o, "Config to sync")).toBe(false);
    expect(await o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.syncObsidianConfig`))
      .toBe(false);
    await setRowControl(o, SYNC_CONFIG_ROW);
    await expect.poll(() => rowShown(o, "Config to sync")).toBe(true);
    /* #64: Developer console sits last on the Logs page, and the page never depends on it. */
    await openSettingsPage(o, "Logs");
    expect(
      (await rowInventory(o)).at(-1),
      "Developer console is the last row of the Logs page",
    ).toMatch(/^Developer console \| /);
    const debugLogging = () =>
      o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.debugLogging`);
    const originalDebugLogging = await debugLogging();
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(!originalDebugLogging);
    await closeSettingsPage(o);
    await expect.poll(() => rowShown(o, "Logs"), { message: "Logs stays reachable" }).toBe(true);
    await openSettingsPage(o, "Logs");
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(debugLogging).toBe(originalDebugLogging);
    await closeSettingsPage(o);

    /* ---- Settings search: Geode's rows are indexed ---- */
    const retention = await searchSettings(o, "retention");
    expect(retention.join("\n")).toContain(TRASH_RETENTION_ROW);
    await shot("defs-08-search-retention.png");
    const autolock = await searchSettings(o, "auto-lock");
    expect(autolock.join("\n")).toContain(AUTO_LOCK_ROW);
    await shot("defs-09-search-autolock.png");
    // #64: the row was called Debug logging, so its old search terms still find it.
    const debugSearch = await searchSettings(o, "debug logging");
    expect(debugSearch.join("\n")).toContain(DEVELOPER_CONSOLE_ROW);
    await searchSettings(o, "");

    /* ---- A re-read of the definitions keeps the live rows bound ---- */
    // Obsidian re-reads them while it indexes settings search; a read must not swap out the
    // objects the rendered status row updates through.
    await o.eval(`
      const tab = app.plugins.plugins.geode.settingTab;
      tab.getSettingDefinitions();
      tab.getSettingDefinitions();
      return true;
    `);
    const syncStatusDesc = () =>
      o.win.locator('[data-testid="geode-settings-sync-status"] .setting-item-description')
        .textContent();
    await o.eval(`app.plugins.plugins.geode.statusBar.updateState("syncing"); return true;`);
    await expect.poll(syncStatusDesc, { timeout: 10_000 }).toMatch(/^Catching up/);
    await o.eval(`app.plugins.plugins.geode.statusBar.updateState("live"); return true;`);
    await expect.poll(syncStatusDesc, { timeout: 10_000 }).toMatch(/^Up to date\. Last backup /);

    /* ---- display() path: same rows, collapsible sections ---- */
    await useDisplayPath(o);
    await expect.poll(() => isDisplayPath(o)).toBe(true);
    await o.win.waitForTimeout(1000);
    await shot("display-01-top.png");
    await openSettingsPage(o, "Advanced");
    await openSettingsPage(o, "Logs");
    await shot("display-02-logs.png");
    expectSameRows(await rowInventory(o), {
      main: defsMain,
      advanced: defsAdvanced,
      logs: defsLogs,
    });
    expect(await readRowControl(o, TRASH_RETENTION_ROW)).toBe("45");
    // A rejected value shows the reason and puts the stored one back (as Obsidian does on 1.13+).
    await setRowControl(o, TRASH_RETENTION_ROW, "0");
    await expect.poll(() => readRowControl(o, TRASH_RETENTION_ROW)).toBe("45");
    expect(
      await o.eval<string>(`[...document.querySelectorAll(".modal.mod-settings .geode-error")]
        .map((e) => e.textContent).filter((s) => s).join(" ")`),
    ).toContain(WHOLE_NUMBER_COPY);
    expect(await o.eval<number>(`app.plugins.plugins.geode.pluginSettings.trashRetentionDays`))
      .toBe(45);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await expect.poll(() => rowShown(o, "Copy logs"), {
      message: "display(): the Logs rows stay shown",
    })
      .toBe(true);
    await setRowControl(o, DEVELOPER_CONSOLE_ROW);
    await useDisplayPath(o, false);
    await expect.poll(() => isDisplayPath(o)).toBe(false);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
