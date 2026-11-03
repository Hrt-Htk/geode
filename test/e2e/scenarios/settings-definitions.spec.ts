import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openSettingsTab } from "../helpers/logs";
import {
  closeSettingsPage,
  isDisplayPath,
  openSettingsPage,
  readRowControl,
  rowInventory,
  rowShown,
  searchSettings,
  setRowControl,
  useDisplayPath,
} from "../helpers/settings-tab";

// #16: Obsidian 1.13+ renders the Geode tab from getSettingDefinitions() (status block,
// Vault/Devices/Sync scope/Trash groups, Advanced and Logs sub-pages) and indexes it for
// settings search; display() renders the same rows for Obsidian < 1.13. One run drives both
// paths on the installed Obsidian and asserts the same rows and testids, so they cannot drift.

const PASSPHRASE = "settings-definitions-pass";

const clearNotices =
  `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`;

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
      await o.eval(clearNotices);
      await modal.screenshot({ path: shotPath(name) });
    };
    const scrollTo = (name: string) =>
      o.eval(`(() => {
        const el = [...document.querySelectorAll(".modal.mod-settings .setting-item-heading, .modal.mod-settings .setting-group-heading, .modal.mod-settings .setting-item-name")]
          .find((e) => e.textContent.trim() === ${JSON.stringify(name)});
        el?.scrollIntoView({ block: "start" });
        return !!el;
      })()`);

    /* ---- Definitions path (Obsidian 1.13+) ---- */
    await openSettingsTab(o);
    expect(await isDisplayPath(o), "1.13+ renders from definitions").toBe(false);
    await expect.poll(() =>
      o.eval<string[]>(
        `[...document.querySelectorAll(".modal.mod-settings .setting-group .setting-item-heading")].map((h) => h.textContent.trim())`,
      )
    ).toEqual(["Vault", "Devices", "Sync scope", "Trash"]);
    expect(await rowShown(o, "Advanced"), "Advanced is a page entry").toBe(true);
    expect(await rowShown(o, "Logs"), "Logs is a page entry while debug logging is on").toBe(true);
    await o.win.waitForTimeout(1000);
    await shot("defs-01-top.png");
    for (const [i, group] of ["Vault", "Devices", "Sync scope", "Trash"].entries()) {
      expect(await scrollTo(group)).toBe(true);
      await shot(`defs-0${i + 2}-${group.toLowerCase().replace(" ", "-")}.png`);
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
    await setRowControl(o, "Trash retention (days)", "45");
    await expect.poll(() =>
      o.eval<number>(`app.plugins.plugins.geode.pluginSettings.trashRetentionDays`)
    )
      .toBe(45);
    await setRowControl(o, "Auto lock after (hours)", "0");
    await o.win.waitForTimeout(300);
    expect(
      await o.eval<number>(`app.plugins.plugins.geode.pluginSettings.unlockTimeoutHours`),
      "0 is rejected",
    )
      .toBe(24);
    expect(await readRowControl(o, "Sync config folder")).toBe("on");
    expect(await rowShown(o, "Config to sync")).toBe(true);
    await setRowControl(o, "Sync config folder");
    await expect.poll(() => rowShown(o, "Config to sync")).toBe(false);
    expect(await o.eval<boolean>(`app.plugins.plugins.geode.pluginSettings.syncObsidianConfig`))
      .toBe(false);
    await setRowControl(o, "Sync config folder");
    await expect.poll(() => rowShown(o, "Config to sync")).toBe(true);
    await openSettingsPage(o, "Advanced");
    await setRowControl(o, "Debug logging");
    await closeSettingsPage(o);
    await expect.poll(() => rowShown(o, "Logs"), { message: "Logs page entry follows the toggle" })
      .toBe(false);
    await openSettingsPage(o, "Advanced");
    await setRowControl(o, "Debug logging");
    await closeSettingsPage(o);
    await expect.poll(() => rowShown(o, "Logs")).toBe(true);

    /* ---- Settings search: Geode's rows are indexed ---- */
    const retention = await searchSettings(o, "retention");
    expect(retention.join("\n")).toContain("Trash retention (days)");
    await shot("defs-08-search-retention.png");
    const autolock = await searchSettings(o, "auto-lock");
    expect(autolock.join("\n")).toContain("Auto lock after (hours)");
    await shot("defs-09-search-autolock.png");
    await searchSettings(o, "");

    /* ---- display() path: same rows, collapsible sections ---- */
    await useDisplayPath(o);
    await expect.poll(() => isDisplayPath(o)).toBe(true);
    await o.win.waitForTimeout(1000);
    await shot("display-01-top.png");
    await openSettingsPage(o, "Advanced");
    await openSettingsPage(o, "Logs");
    await shot("display-02-logs.png");
    const display = await rowInventory(o);
    const pageEntries = ["Advanced | ", "Logs | "];
    expect(defsMain).toEqual(expect.arrayContaining(pageEntries));
    const defsRows = [...defsMain, ...defsAdvanced, ...defsLogs]
      .filter((r) => !pageEntries.includes(r));
    expect([...display].sort()).toEqual(defsRows.sort());
    expect(await readRowControl(o, "Trash retention (days)")).toBe("45");
    await setRowControl(o, "Debug logging");
    await expect.poll(() => rowShown(o, "Copy logs"), { message: "display(): Logs hides in place" })
      .toBe(false);
    await useDisplayPath(o, false);
    await expect.poll(() => isDisplayPath(o)).toBe(false);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
