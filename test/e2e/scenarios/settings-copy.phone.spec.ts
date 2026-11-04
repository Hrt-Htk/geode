import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { openSettingsTab } from "../helpers/logs";
import { closeSettingsPage, openSettingsPage } from "../helpers/settings-tab";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #479: owner clarification: on phone a two-line wrap is fine; what must go is
// multi-line description text that fills the view (three-plus-line row blocks).
// This spec opens the configured, unlocked settings tab with every section
// expanded and asserts no description runs three or more lines, then captures
// the tab on-device. The desktop counterpart (settings-copy) requires one line.
const PASSPHRASE = "phone-pass";

async function clearNotices(obsidian: { eval: (s: string) => Promise<unknown> }): Promise<void> {
  await obsidian.eval(`
    document.querySelectorAll('.notice').forEach((n) => n.remove());
    return true;
  `);
}

/** Shown descriptions taller than two lines, as "name = text (n lines)". */
function tallDescriptions(o: { eval: <T>(s: string) => Promise<T> }): Promise<string[]> {
  return o.eval<string[]>(`
    (() => {
      const out = [];
      for (const desc of document.querySelectorAll(".modal.mod-settings .setting-item-description")) {
        if (desc.offsetParent === null) continue;
        const lh = parseFloat(getComputedStyle(desc).lineHeight) || 20;
        const lines = desc.getBoundingClientRect().height / lh;
        if (lines > 2.6) {
          const name = desc.closest(".setting-item")?.querySelector(".setting-item-name")?.textContent?.trim() ?? "?";
          out.push(name + " = " + desc.textContent.trim().replace(/\\s+/g, " ") + " (" + Math.round(lines) + " lines)");
        }
      }
      return out;
    })()
  `);
}

test("phone copy: no settings description runs three or more lines", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("phone-copy");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
      syncObsidianConfig: true,
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

    await openSettingsTab(obsidian, true);
    await clearNotices(obsidian);
    await new Promise((r) => setTimeout(r, 1_500));

    // The tab, then its Advanced and Logs pages (#16): every row is checked once.
    const tall = await tallDescriptions(obsidian);
    for (const page of ["Advanced", "Logs"] as const) {
      await openSettingsPage(obsidian, page);
      await new Promise((r) => setTimeout(r, 800));
      tall.push(...await tallDescriptions(obsidian));
      await clearNotices(obsidian);
      await obsidian.screenshot(shotPath(`479-02-phone-${page.toLowerCase()}.png`));
      await closeSettingsPage(obsidian);
    }
    expect(tall, "no phone settings description may run three or more lines").toEqual([]);

    await clearNotices(obsidian);
    await obsidian.screenshot(shotPath("479-01-phone-settings.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
