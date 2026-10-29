import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #430: the mobile status icon taps open the same native Menu as desktop (rendered as a
// bottom sheet on .is-phone). Items are asserted in mockup order; the Pause entry reflects
// the live pause state and is hidden while locked (#441).
const PASSPHRASE = "status-menu-pass";

const MOBILE = '[data-testid="geode-mobile-status"]';
const UNLOCKED_LABELS = [
  "Pause",
  "Sync activity",
  "Conflicts",
  "Deleted files",
  "Devices",
  "Geode settings",
];
const LOCKED_LABELS = ["Sync activity", "Conflicts", "Deleted files", "Devices", "Geode settings"];

async function tapMenu(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(
    `document.querySelector(${JSON.stringify(MOBILE)}).click(); return true;`,
  );
  await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
    timeout: 10_000,
  });
}

async function menuLabels(obsidian: PhoneInstance): Promise<string[]> {
  return await obsidian.eval<string[]>(
    `Array.from(document.querySelectorAll(".menu .menu-item-title")).map((el) => el.textContent || "")`,
  );
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

test("status menu (phone): tap opens the bottom-sheet menu, items in order", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("status-menu");
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    keepStartupModal: true,
  });

  try {
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Tap the mobile status icon → bottom-sheet menu, items in mockup order ---- */
    await tapMenu(obsidian);
    expect(await menuLabels(obsidian)).toEqual(UNLOCKED_LABELS);

    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("430-phone-01-menu.png"));

    /* ---- Pause toggles to Resume and sync pauses ---- */
    await tapMenuItem(obsidian, "Pause");
    await expect(obsidian.win.locator('[data-testid="geode-statusbar"]')).toHaveAttribute(
      "title",
      /^Sync paused\. /,
      { timeout: 30_000 },
    );
    await tapMenu(obsidian);
    expect(await menuLabels(obsidian)).toEqual([
      "Resume",
      "Sync activity",
      "Conflicts",
      "Deleted files",
      "Devices",
      "Geode settings",
    ]);
    await tapMenuItem(obsidian, "Resume");
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* ---- Deleted files opens the trash modal (#446) ---- */
    await tapMenu(obsidian);
    await tapMenuItem(obsidian, "Deleted files");
    await expect(
      obsidian.win.locator(".geode-trash-modal"),
    ).toBeVisible({ timeout: 15_000 });
    await dismissModals(obsidian);
    await expect(obsidian.win.locator(".geode-trash-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- Geode settings opens the settings tab ---- */
    await tapMenu(obsidian);
    await tapMenuItem(obsidian, "Geode settings");
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-sync-status"]'),
    ).toBeVisible({ timeout: 15_000 });

    /* ---- Locked: menu shows the non-pause items only (#441) ---- */
    await obsidian.eval(`app.setting?.close?.(); return true;`);
    await obsidian.eval(`app.plugins.plugins.geode.lockVault(); return true;`);
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 15_000 })
      .toContain("Geode: locked");
    await tapMenu(obsidian);
    expect(await menuLabels(obsidian)).toEqual(LOCKED_LABELS);
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
