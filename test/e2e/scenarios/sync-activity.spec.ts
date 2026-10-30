import { expect, test } from "@playwright/test";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForConvergence, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #431: the Sync activity modal: two devices on a throwaway server, several
// edits on A and some on B. One row per file (latest activity) with save count;
// a remote file shows Downloaded; a delete is its own row with absolute clock
// time; All/Conflicts/Errors tabs and live file-name search work; the log
// survives a plugin reload. Entry points: the status-bar menu and
// Settings → Sync activity [View].
const PASSPHRASE = "sync-activity-pass";
const SHOT_MODAL = "431-01-activity-modal.png";
const SHOT_SETTINGS = "431-02-activity-from-settings.png";
const SHOT_FOOTER = "431-03-activity-footer-status.png";

const STATUSBAR = '[data-testid="geode-statusbar"]';
const MODAL = ".geode-activity-modal";
const row = (o: ObsidianPair["A"], p: string) =>
  o.win.locator(`${MODAL} [data-testid="geode-activity-row"][data-path="${p}"]`);
const rowDesc = (o: ObsidianPair["A"], p: string) =>
  row(o, p).locator(".geode-activity-desc").textContent() ?? "";

async function openMenu(o: ObsidianPair["A"]): Promise<void> {
  await o.win.locator(STATUSBAR).click();
  await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
}

async function openActivityFromMenu(o: ObsidianPair["A"]): Promise<void> {
  await openMenu(o);
  await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

async function closeActivity(o: ObsidianPair["A"]): Promise<void> {
  await o.win.keyboard.press("Escape");
  await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
}

test("sync activity: per-file rows, save count, delete row, filters, search, reload", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    /* ---- Give the devices names so rows can be asserted on the label ---- */
    await pair.A.eval(`
      app.plugins.plugins.geode.pluginSettings.deviceName = "Laptop";
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);
    await pair.B.eval(`
      app.plugins.plugins.geode.pluginSettings.deviceName = "Phone";
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    /* ---- A: three saves of alpha.md (one row, save count) ---- */
    for (let i = 1; i <= 3; i++) {
      await upsertVaultFile(pair.A, "notes/alpha.md", `# Alpha\nsave ${i}\n`);
      await commitPath(pair.A, "notes/alpha.md");
    }

    /* ---- B: one save of beta.md (Downloaded on A) ---- */
    await upsertVaultFile(pair.B, "notes/beta.md", "# Beta\nfrom B\n");
    await commitPath(pair.B, "notes/beta.md");

    /* ---- A: create then delete del.md (delete is its own row) ---- */
    await upsertVaultFile(pair.A, "notes/del.md", "# Del\n");
    await commitPath(pair.A, "notes/del.md");
    await pair.A.eval(`
      const file = app.vault.getFileByPath("notes/del.md");
      if (!file) throw new Error("expected del.md to exist");
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(pair.A, "notes/del.md", "delete");

    /* ---- Both devices converge ---- */
    await expect.poll(async () => await readGeodeStatusBar(pair.A.win), { timeout: 60_000 })
      .toContain(
        "Geode: synced",
      );
    await expect.poll(async () => await readGeodeStatusBar(pair.B.win), { timeout: 60_000 })
      .toContain(
        "Geode: synced",
      );
    await expect
      .poll(() => pair.B.eval<boolean>(`app.vault.adapter.exists("notes/del.md")`))
      .toBe(false);
    await waitForConvergence(pair.A, pair.B, "notes/beta.md", 60_000);

    /* ---- Open from the status menu: one row per file, latest activity ---- */
    await openActivityFromMenu(pair.A);
    await expect(pair.A.win.locator(`${MODAL} .geode-activity-header`).first()).toHaveText("Today");

    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();
    expect(await rowDesc(pair.A, "notes/alpha.md")).toBe("Uploaded · Laptop · 3 saves");
    await expect(row(pair.A, "notes/beta.md")).toBeVisible();
    /* Remote rows resolve to the device's server-side name (#433) once the
       device list lands; poll past the one-shot fetch. */
    await expect.poll(async () => await rowDesc(pair.A, "notes/beta.md")).toBe(
      "Downloaded · device-B",
    );
    await expect(row(pair.A, "notes/del.md")).toBeVisible();
    expect(await rowDesc(pair.A, "notes/del.md")).toBe("Deleted · Laptop");
    /* Delete rows show an absolute clock time, not a relative one. */
    expect(await row(pair.A, "notes/del.md").locator(".geode-activity-time").textContent()).toMatch(
      /^\d{2}:\d{2}$/,
    );
    /* Most recent first: the delete (last event) leads, then beta, then alpha. */
    const names = await pair.A.win
      .locator(`${MODAL} .geode-activity-name`)
      .allTextContents();
    expect(names.indexOf("del.md")).toBeLessThan(names.indexOf("beta.md"));
    expect(names.indexOf("beta.md")).toBeLessThan(names.indexOf("alpha.md"));

    /* ---- #522 footer status: the settings row's text + dot, left of Done ---- */
    const footerStatus = pair.A.win.locator('[data-testid="geode-activity-status"]');
    await expect(footerStatus).toContainText("Up to date.");
    await expect(footerStatus.locator(".geode-sync-dot-green")).toBeVisible();
    /* One line, left of Done, no overlap: measured on the boxes, not eyeballed. */
    const statusBox = (await footerStatus.boundingBox())!;
    const doneBox =
      (await pair.A.win.locator('[data-testid="geode-activity-done"]').boundingBox())!;
    expect(statusBox.height).toBeLessThan(28);
    expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(doneBox.x);
    /* Live while open: pause/resume flip the line. */
    await pair.A.eval(`await app.plugins.plugins.geode.pauseSync(); return true;`);
    await expect(footerStatus).toContainText("Paused.");
    await expect(footerStatus.locator(".geode-sync-dot-grey")).toBeVisible();
    await pair.A.eval(`await app.plugins.plugins.geode.resumeSync(); return true;`);
    await expect(footerStatus).toContainText("Up to date.", { timeout: 60_000 });
    await expect(footerStatus.locator(".geode-sync-dot-green")).toBeVisible();
    await pair.A.win.locator('[data-testid="geode-activity-footer"]').screenshot({
      path: shotPath(SHOT_FOOTER),
    });

    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath(SHOT_MODAL) });

    /* ---- Filters: Conflicts and Errors are empty here, All restores ---- */
    await pair.A.win.locator('[data-testid="geode-activity-filter-conflict"]').click();
    await expect(pair.A.win.locator('[data-testid="geode-activity-empty"]')).toBeVisible();
    await pair.A.win.locator('[data-testid="geode-activity-filter-error"]').click();
    await expect(pair.A.win.locator('[data-testid="geode-activity-empty"]')).toBeVisible();
    await pair.A.win.locator('[data-testid="geode-activity-filter-all"]').click();
    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();

    /* ---- Search: live file-name filter, No matches, clear restores ---- */
    const search = pair.A.win.locator('[data-testid="geode-activity-search"]');
    await search.fill("alpha");
    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();
    await expect(row(pair.A, "notes/beta.md")).toHaveCount(0);
    await search.fill("zzz-no-such-file");
    await expect(pair.A.win.locator('[data-testid="geode-activity-no-matches"]')).toHaveText(
      "No matches.",
    );
    await pair.A.win.locator(`${MODAL} .search-input-clear-button`).click();
    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();
    await closeActivity(pair.A);

    /* ---- Open from Settings → Sync activity [View] ---- */
    await pair.A.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await pair.A.win.locator('[data-testid="geode-settings-activity-view"]').click();
    await expect(pair.A.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath(SHOT_SETTINGS) });
    await closeActivity(pair.A);
    await pair.A.eval(`app.setting?.close?.(); return true;`);

    /* ---- The log survives a plugin reload (persisted, capped) ---- */
    await pair.A.eval(`
      await app.plugins.disablePlugin("geode");
      await app.plugins.enablePlugin("geode");
      return true;
    `);
    await expect
      .poll(
        async () =>
          await pair.A.eval<number>(`app.plugins.plugins.geode?.activity?.entries.size ?? 0`),
        {
          timeout: 30_000,
        },
      )
      .toBeGreaterThanOrEqual(3);
    await openActivityFromMenu(pair.A);
    await expect(row(pair.A, "notes/alpha.md")).toBeVisible();
    expect(await rowDesc(pair.A, "notes/alpha.md")).toBe("Uploaded · Laptop · 3 saves");
    await closeActivity(pair.A);
  } finally {
    await pair.stop();
  }
});
