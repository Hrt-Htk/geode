import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import { openSettingsTab } from "../helpers/logs";
import {
  AUTO_LOCK_ROW,
  closeSettingsPage,
  expectSameRows,
  isDisplayPath,
  openSettingsPage,
  rowInventory,
  rowShown,
  scrollToHeading,
  searchSettings,
  shownSections,
  TRASH_RETENTION_ROW,
  useDisplayPath,
} from "../helpers/settings-tab";

// #16 on-device: Obsidian mobile 1.13+ renders the Geode tab from getSettingDefinitions()
// (groups + Advanced/Logs sub-pages) and its settings search finds Geode's rows; display()
// renders the same rows. Screenshots of every part for the owner's review.

const PASSPHRASE = "settings-definitions-phone-pass";

test("settings tab (phone): definitions and display() render the same rows; search finds Geode", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();
  const server = await useRemoteServer();
  const device = await server.mintToken("settings-definitions-phone");
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
    await o.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await dismissModals(o);
    const shot = async (name: string) => {
      // Mobile slides a sub-page in: shoot after it stops moving, or the frame catches it
      // half way in (a row clipped at the right edge, the card flush to the screen).
      await o.eval(`(async () => {
        const el = document.querySelector(".modal.mod-settings .setting-page") ??
          document.querySelector(".modal.mod-settings .vertical-tab-content");
        let prev = -1;
        for (let i = 0; i < 40; i++) {
          const left = Math.round(el?.getBoundingClientRect().left ?? 0);
          if (left === prev) return true;
          prev = left;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })()`);
      await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
      await o.screenshot(shotPath(name));
    };

    /* ---- Definitions path ---- */
    await openSettingsTab(o, true);
    expect(await isDisplayPath(o), "1.13+ renders from definitions").toBe(false);
    expect(await shownSections(o)).toEqual(
      ["Vault", "Devices", "Sync scope", "Trash", "Advanced", "Logs"],
    );
    await shot("defs-phone-01-top.png");
    for (const [i, group] of ["Vault", "Devices", "Sync scope", "Trash"].entries()) {
      expect(await scrollToHeading(o, group, 72)).toBe(true);
      await shot(`defs-phone-0${i + 2}-${group.toLowerCase().replace(" ", "-")}.png`);
    }
    const defsMain = await rowInventory(o);
    await openSettingsPage(o, "Advanced");
    await shot("defs-phone-06-advanced.png");
    const defsAdvanced = await rowInventory(o);
    await closeSettingsPage(o);
    await openSettingsPage(o, "Logs");
    await shot("defs-phone-07-logs.png");
    const defsLogs = await rowInventory(o);
    await closeSettingsPage(o);

    /* ---- Settings search (the tab list holds the search field on a phone) ---- */
    await o.eval(`app.setting.closeActiveTab(); return true;`);
    await new Promise((r) => setTimeout(r, 800));
    expect((await searchSettings(o, "retention")).join("\n")).toContain(TRASH_RETENTION_ROW);
    await shot("defs-phone-08-search-retention.png");
    expect((await searchSettings(o, "auto-lock")).join("\n")).toContain(AUTO_LOCK_ROW);
    await shot("defs-phone-09-search-autolock.png");
    await searchSettings(o, "");

    /* ---- display() path: the same rows ---- */
    await o.eval(`app.setting.openTabById("geode"); return true;`);
    await useDisplayPath(o);
    await expect.poll(() => isDisplayPath(o)).toBe(true);
    await shot("display-phone-01-top.png");
    await openSettingsPage(o, "Advanced");
    await openSettingsPage(o, "Logs");
    await shot("display-phone-02-logs.png");
    expectSameRows(await rowInventory(o), {
      main: defsMain,
      advanced: defsAdvanced,
      logs: defsLogs,
    });
    expect(await rowShown(o, "Copy logs")).toBe(true);
    await useDisplayPath(o, false);
    await expect.poll(() => isDisplayPath(o)).toBe(false);
    await o.eval(`app.setting.close(); return true;`);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
