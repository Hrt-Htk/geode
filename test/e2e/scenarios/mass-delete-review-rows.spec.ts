import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { restartHeld, type SeedFile, writeSeedVault } from "../helpers/mass-delete-seed";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// #601: the two surfaces the approved mockup had no frame for (held files at the vault root,
// the Trash-section Review row) and the two banners that now render through BannerRow
// (outage, pause), desktop only.

const PASSPHRASE = "mass-delete-review-pass";
const HOLD = "app.plugins.plugins.geode.settings.massDeleteHold";

type SeedSettings = {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  salt: string;
  debugLogging: boolean;
  syncObsidianConfig: boolean;
};

async function seedServer(): Promise<{ server: E2EServer; settings: SeedSettings }> {
  const server = await startServer();
  const device = await server.mintToken("mass-delete-review");
  return {
    server,
    settings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
      syncObsidianConfig: false,
    },
  };
}

test("601 root row: a held root file gets its own last row, off then selected", async () => {
  test.setTimeout(10 * 60_000);
  const { server, settings } = await seedServer();
  const folder = Array.from({ length: 20 }, (_, i) => `notes/n${String(i).padStart(2, "0")}.md`);
  const root = ["alpha.md", "beta.md"];
  const others = ["other/keep-1.md", "other/keep-2.md"];
  const tracked: SeedFile[] = [...folder, ...root, ...others].map((p, i) => ({
    path: p,
    edited: Date.UTC(2026, 9, 1) + i * 3_600_000,
  }));
  const vaultDir = await mkdtemp(path.join(tmpdir(), "geode-601-root-"));
  await writeSeedVault(vaultDir, tracked, (f) => `# ${f.path}\n`);

  let o = await launchObsidian({
    geodeSettings: settings,
    unlockPassphrase: PASSPHRASE,
    vaultDir,
    keepVaultDir: true,
  });

  try {
    await waitForUnlocked(o);
    await expect
      .poll(
        () =>
          o.eval<number>(
            "app.plugins.plugins.geode.syncManager?.state?.getAllLocalFiles().size ?? 0",
          ),
        { timeout: 5 * 60_000 },
      )
      .toBe(tracked.length);
    await waitForStatusBar(o.win, "Geode: synced", 120_000);

    o = await restartHeld(
      o,
      [...folder.map((p) => ({ path: p })), ...root.map((p) => ({ path: p }))],
      22,
      PASSPHRASE,
    );
    const notice = o.win.locator(".notice").last();
    await expect(notice).toContainText("22 files missing. Sync is on hold. Click to review.");
    await notice.click();
    await expect(o.win.locator(".geode-missing-modal")).toBeVisible({ timeout: 10_000 });

    const rows = o.win.locator(".geode-missing-tree > .tree-item");
    await expect(rows.last()).toContainText(/^Root \(/);
    await expect(rows.last()).toContainText("2");
    await expect(o.win.locator(".geode-missing-foot")).toContainText("Restore 22 files");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-25-root-row.png"),
    });

    // Selected: only the two root files are marked for deletion.
    const rootToggle = rows.last().locator('[data-testid="geode-missing-root-toggle"]');
    await rootToggle.click();
    await expect(o.win.locator(".geode-missing-foot")).toContainText(
      "Delete 2 files, restore 20",
    );
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-25b-root-row-selected.png"),
    });

    // The Trash section's Review row, while the hold is in force.
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(".geode-missing-modal")).toHaveCount(0);
    await openSettingsTab(o);
    const trashHold = o.win.locator('[data-testid="geode-settings-trash-hold"]');
    await trashHold.scrollIntoViewIfNeeded();
    await expect(trashHold).toBeVisible();
    await expect(trashHold).toContainText("22 files missing");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.mouse.move(2, 2);
    await trashHold.screenshot({ path: shotPath("601-26-trash-section-row.png") });

    // #628: a version refusal is a hard stop: its banner sits above the hold row.
    await o.eval(
      `app.plugins.plugins.geode.onBlocked("9.9.9", app.plugins.plugins.geode.manifest.version, "below minimum"); return true;`,
    );
    await expect(
      o.win.locator('[data-testid="geode-settings-hold-banner"]'),
    ).toHaveCount(1);
    await expect(o.win.locator(".geode-version-warning-icon")).toBeVisible();
    const bannerOrder = await o.eval<string[]>(
      `[...document.querySelectorAll("[data-banner-order]")].map((el) => el.dataset.bannerOrder + ":" + (el.dataset.testid ?? ""))`,
    );
    expect(bannerOrder[0].startsWith("0:")).toBe(true);
    expect(bannerOrder.indexOf("1:geode-settings-hold-banner")).toBeGreaterThan(0);
    await o.eval(
      `app.plugins.plugins.geode.onServerVersion(app.plugins.plugins.geode.manifest.version); return true;`,
    );
    await expect(o.win.locator(".geode-version-warning-icon")).toHaveCount(0);
    expect(await o.eval<unknown>(HOLD)).not.toBe(null);
  } finally {
    await o.close().catch(() => {});
    await server.stop();
  }
});

test("601 banners: the outage and pause rows render through BannerRow", async () => {
  test.setTimeout(5 * 60_000);
  const { server, settings } = await seedServer();
  const o: ObsidianInstance = await launchObsidian({
    geodeSettings: settings,
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 120_000);
    await openSettingsTab(o);

    // Pause: the row is grey, names the age, and offers Resume.
    await o.eval("await app.plugins.plugins.geode.pauseSync(); return true;");
    const pause = o.win.locator('[data-testid="geode-settings-pause-banner"]');
    await expect(pause).toBeVisible({ timeout: 15_000 });
    await expect(pause).toContainText("Sync paused");
    await expect(pause).toContainText("Resume");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.mouse.move(2, 2);
    await pause.screenshot({ path: shotPath("601-28-pause-banner.png") });

    // Resume, then simulate an outage: after the 10 s grace the row appears with Retry.
    await o.eval("await app.plugins.plugins.geode.resumeSync(); return true;");
    await expect(pause).toHaveCount(0, { timeout: 30_000 });
    await o.eval("app.plugins.plugins.geode.transport.stop(); return true;");
    const outage = o.win.locator('[data-testid="geode-settings-error-banner"]');
    await expect(outage).toBeVisible({ timeout: 30_000 });
    await expect(outage).toContainText("Cannot reach your Geode server");
    await expect(outage).toContainText("Retry");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.mouse.move(2, 2);
    await outage.screenshot({ path: shotPath("601-27-error-banner.png") });
  } finally {
    await o.close().catch(() => {});
    await server.stop();
  }
});
