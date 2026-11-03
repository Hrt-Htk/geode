import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { openSettingsTab } from "../helpers/logs";
import { closeSettingsPage, openSettingsPage } from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";

// #479: the owner copy rule: every settings row description fits on ONE line at
// the default desktop settings width, plain and without dashes. This spec opens
// the configured, unlocked settings tab with every section expanded (Advanced +
// Logs pages included, Sync config folder on) and asserts no description wraps, then
// captures the tab for visual review. The phone counterpart (settings-copy.phone)
// allows a two-line wrap but rejects three-plus-line blocks.
const PASSPHRASE = "settings-copy-pass";

/** Collect every settings-row description's height vs its line height. */
async function wrappedDescriptions(o: { eval: <T>(s: string) => Promise<T> }): Promise<string[]> {
  return await o.eval<string[]>(`
    (() => {
      const out = [];
      for (const desc of document.querySelectorAll(".modal.mod-settings .setting-item-description")) {
        if (desc.offsetParent === null) continue;
        const lh = parseFloat(getComputedStyle(desc).lineHeight) || 20;
        const h = desc.getBoundingClientRect().height;
        if (h > lh * 1.6) {
          const name = desc.closest(".setting-item")?.querySelector(".setting-item-name")?.textContent?.trim() ?? "?";
          out.push(name + " = " + desc.textContent.trim().replace(/\\s+/g, " ") + " (" + Math.round(h / lh) + " lines)");
        }
      }
      return out;
    })()
  `);
}

/** Capture the whole Geode tab as real painted segments: scroll the content
 * column and shoot each viewport step (the height:auto trick leaves unpainted
 * blank below the modal's clip, so scrolling is the only honest capture). */
async function captureSettingsSegments(
  o: { eval: <T>(s: string) => Promise<T> },
  win: { locator: (sel: string) => { screenshot: (opts: { path: string }) => Promise<unknown> } },
  baseName: string,
): Promise<void> {
  const content = win.locator(".vertical-tab-content").last();
  const steps = await o.eval<number[]>(
    `(() => {
      const el = document.querySelectorAll(".vertical-tab-content")[document.querySelectorAll(".vertical-tab-content").length - 1];
      if (!el) return [];
      const out = [0];
      const step = el.clientHeight;
      for (let y = step; y < el.scrollHeight; y += step) out.push(y);
      return out;
    })()`,
  );
  for (let i = 0; i < steps.length; i++) {
    await o.eval(
      `(() => { const els = document.querySelectorAll(".vertical-tab-content"); const el = els[els.length - 1]; el.scrollTop = ${
        steps[i]
      }; return el.scrollTop; })()`,
    );
    await o.win.waitForTimeout(150);
    await content.screenshot({
      path: shotPath(`${baseName}-${String(i + 1).padStart(2, "0")}.png`),
    });
  }
}

test("copy: every settings description is one line, no dashes", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("settings-copy");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
      syncObsidianConfig: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    await openSettingsTab(o);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    // Let live rows (trash count, storage, devices summary, sync status) settle.
    await o.win.waitForTimeout(2_000);

    // The tab, then its Advanced and Logs pages (#16): every row is checked once.
    const wrapped = await wrappedDescriptions(o);
    await captureSettingsSegments(o, o.win, "479-01-settings-all-sections");
    for (const page of ["Advanced", "Logs"] as const) {
      await openSettingsPage(o, page);
      await o.win.waitForTimeout(500);
      wrapped.push(...await wrappedDescriptions(o));
      await o.win.locator(".modal.mod-settings").screenshot({
        path: shotPath(`479-02-settings-${page.toLowerCase()}.png`),
      });
      await closeSettingsPage(o);
    }
    expect(wrapped, "no settings description may wrap to a second line on desktop").toEqual([]);
  } finally {
    await o.close();
    await server.stop?.();
  }
});
