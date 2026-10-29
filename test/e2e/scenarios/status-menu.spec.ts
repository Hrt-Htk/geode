import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #430: the status-bar icon opens a native Menu (Pause/Resume, Deleted files, Geode settings),
// not the debug pane. Items are asserted in mockup order; each item opens its target; the Pause
// entry reflects the live pause state and is hidden while locked (#441).
const PASSPHRASE = "status-menu-pass";

const STATUSBAR = '[data-testid="geode-statusbar"]';
const menuTitles = (o: Awaited<ReturnType<typeof launchObsidian>>) =>
  o.win.locator(".menu").last().locator(".menu-item-title");

const UNLOCKED_LABELS = [
  "Pause",
  "Sync activity",
  "Conflicts",
  "Deleted files",
  "Devices",
  "Geode settings",
];
const LOCKED_LABELS = ["Sync activity", "Conflicts", "Deleted files", "Devices", "Geode settings"];

async function openMenu(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<void> {
  await o.win.locator(STATUSBAR).click();
  await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
}

async function clickMenuItem(
  o: Awaited<ReturnType<typeof launchObsidian>>,
  label: string,
): Promise<void> {
  await o.win.locator(".menu").last().locator(".menu-item", { hasText: label }).click();
  await expect(o.win.locator(".menu")).toHaveCount(0, { timeout: 10_000 });
}

test("status menu: items in order, each opens its target, locked hides pause", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("status-menu");
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

    /* ---- Unlocked menu: items in mockup order + separator + icons ---- */
    await openMenu(o);
    await expect(menuTitles(o)).toHaveText(UNLOCKED_LABELS);
    await expect(o.win.locator(".menu").last().locator(".menu-separator")).toHaveCount(1);
    const icons = await o.win.locator(".menu").last().locator(".menu-item-icon svg").evaluateAll(
      (els) =>
        els.map((el) => (el.getAttribute("class") ?? "").match(/lucide-([a-z0-9-]+)/)?.[1] ?? ""),
    );
    expect(icons).toEqual(["pause", "activity", "git-merge", "trash-2", "laptop", "settings"]);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".menu").last().screenshot({ path: shotPath("430-01-status-menu.png") });

    /* ---- Pause: status bar pauses, menu now reads Resume ---- */
    await clickMenuItem(o, "Pause");
    await expect(o.win.locator(STATUSBAR)).toHaveClass(/geode-statusbar-paused-grey/);
    await expect(o.win.locator(STATUSBAR)).toHaveAttribute("title", /^Sync paused\. /);

    await openMenu(o);
    await expect(menuTitles(o)).toHaveText([
      "Resume",
      "Sync activity",
      "Conflicts",
      "Deleted files",
      "Devices",
      "Geode settings",
    ]);

    /* ---- Resume: status bar returns to synced ---- */
    await clickMenuItem(o, "Resume");
    await expect
      .poll(async () => await readGeodeStatusBar(o.win), { timeout: 15_000 })
      .toContain("Geode: synced");
    await expect(o.win.locator(STATUSBAR)).toHaveClass(/geode-statusbar-ok/);

    /* ---- Deleted files: opens the trash modal (#446) ---- */
    await openMenu(o);
    await clickMenuItem(o, "Deleted files");
    await expect(
      o.win.locator(".geode-trash-modal"),
    ).toBeVisible({ timeout: 15_000 });
    await o.eval(
      `document.querySelector(".geode-trash-modal .modal-header-button")?.click(); return true;`,
    );
    await expect(o.win.locator(".geode-trash-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- Geode settings: opens the settings tab ---- */
    await openMenu(o);
    await clickMenuItem(o, "Geode settings");
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toBeVisible({
      timeout: 15_000,
    });

    /* ---- Locked: menu shows the non-pause items only (#441) ---- */
    await o.eval(`app.setting?.close?.(); return true;`);
    await o.eval(`app.plugins.plugins.geode.lockVault(); return true;`);
    await expect
      .poll(async () => await readGeodeStatusBar(o.win), { timeout: 15_000 })
      .toContain("Geode: locked");
    await openMenu(o);
    await expect(menuTitles(o)).toHaveText(LOCKED_LABELS);
    await o.win.locator(".menu").last().screenshot({
      path: shotPath("430-02-status-menu-locked.png"),
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
