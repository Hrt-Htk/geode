import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #431 (phone): the status-menu "Sync activity" entry opens the modal on the
// real device; rows show the file edited on-device with its save count; the
// list renders as rows, not multi-line blocks (is-phone).
const PASSPHRASE = "sync-activity-phone-pass";
const SHOT_MODAL = "431-phone-01-activity-modal.png";

const MOBILE = '[data-testid="geode-mobile-status"]';
const MODAL = ".geode-activity-modal";
const NOTE = "activity-phone.md";

async function tapMenu(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`
    document.querySelector(${JSON.stringify(MOBILE)}).click();
    return true;
  `);
  await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
    timeout: 10_000,
  });
}

async function tapMenuItem(obsidian: PhoneInstance, label: string): Promise<void> {
  await obsidian.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll(".menu .menu-item"));
      const target = items.find(
        (i) => (i.querySelector(".menu-item-title")?.textContent || "").trim() === ${
    JSON.stringify(label)
  },
      );
      if (!target) throw new Error("menu item not found: " + ${JSON.stringify(label)});
      target.click();
      return true;
    })()
  `);
  await expect(obsidian.win.locator(".menu")).toHaveCount(0, { timeout: 10_000 });
}

test("sync activity (phone): menu entry opens the modal with on-device rows", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("sync-activity");
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    /* The reset vault starts locked: unlock with the test passphrase first. */
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Start from an empty log (it persists across runs) ---- */
    await obsidian.eval(`
      app.plugins.plugins.geode.activity.clear();
      app.plugins.plugins.geode.activity.flush();
      return true;
    `);

    /* ---- Two saves of one file on the device ---- */
    await upsertVaultFile(obsidian, NOTE, "# Activity phone\nfirst save\n");
    await commitPath(obsidian, NOTE);
    await upsertVaultFile(obsidian, NOTE, "# Activity phone\nsecond save\n");
    await commitPath(obsidian, NOTE);
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 60_000 })
      .toContain("Geode: synced");

    /* ---- Open from the status menu ---- */
    await tapMenu(obsidian);
    await tapMenuItem(obsidian, "Sync activity");
    await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });

    /* ---- The on-device file is one row with its save count ---- */
    const rowEl = obsidian.win.locator(
      `${MODAL} [data-testid="geode-activity-row"][data-path="${NOTE}"]`,
    );
    await expect(rowEl).toBeVisible({ timeout: 10_000 });
    const desc = (await rowEl.locator(".geode-activity-desc").textContent()) ?? "";
    expect(desc).toContain("Uploaded");
    expect(desc).toContain("2 saves");

    /* ---- #522 footer status: dot + text beside Done, one line, live ---- */
    const footer = obsidian.win.locator('[data-testid="geode-activity-status"]');
    await expect(footer).toContainText("Up to date.", { timeout: 60_000 });
    await expect(footer.locator(".geode-sync-dot-green")).toBeVisible();
    await obsidian.screenshot(shotPath(SHOT_MODAL));
    const boxes = await obsidian.eval<{ s: number[]; d: number[] }>(`(() => {
      const r = (sel) => {
        const b = document.querySelector(sel).getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      };
      return { s: r('[data-testid="geode-activity-status"]'), d: r('[data-testid="geode-activity-done"]') };
    })()`);
    /* Phone: full-width Done on top, the status line at the bottom of the modal. */
    expect(boxes.s[3]).toBeLessThan(28);
    expect(boxes.d[1] + boxes.d[3]).toBeLessThanOrEqual(boxes.s[1]);
    expect(Math.abs(boxes.s[0] - boxes.d[0])).toBeLessThan(2);
    await obsidian.eval(`await app.plugins.plugins.geode.pauseSync(); return true;`);
    await expect(footer).toContainText("Paused.");
    await obsidian.eval(`await app.plugins.plugins.geode.resumeSync(); return true;`);
    await expect(footer).toContainText("Up to date.", { timeout: 60_000 });

    /* ---- Close (mobile WebView: route through the dismiss helper) ---- */
    await dismissModals(obsidian);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
