import { expect, test } from "@playwright/test";
import { type GeodeSettings, launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { mockupSet, restartHeld, writeSeedVault } from "../helpers/mass-delete-seed";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// #601: the approved shots for the held mass-delete review, rendered by the real plugin in a
// real vault. The vault is seeded with the mockup's exact missing set, synced, then the set is
// deleted behind the app's back and the app restarts: the reconciler trips the guard, which is
// the real detection path. Every number and folder in the window therefore matches the mockup.

const PASSPHRASE = "mass-delete-ui-pass";
const REVIEW = ".geode-missing-modal";
const HOLD = "app.plugins.plugins.geode.pluginSettings.massDeleteHold";

type SeedSettings =
  & Partial<GeodeSettings>
  & Pick<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">;

async function seedServer(): Promise<{ server: E2EServer; settings: SeedSettings }> {
  const server = await startServer();
  const device = await server.mintToken("mass-delete-ui");
  return {
    server,
    settings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
      // The reviewed total must be the seeded files only; config sync would add .obsidian rows.
      syncObsidianConfig: false,
    },
  };
}

async function waitTracked(o: ObsidianInstance, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        o.eval<number>(
          "app.plugins.plugins.geode.syncManager?.state?.getAllLocalFiles().size ?? 0",
        ),
      { timeout: 15 * 60_000 },
    )
    .toBe(count);
  await expect
    .poll(
      () => o.eval<number>("app.plugins.plugins.geode.getPendingCount()"),
      { timeout: 5 * 60_000 },
    )
    .toBe(0);
}

async function clearNotices(o: ObsidianInstance): Promise<void> {
  await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
}

async function readReview(o: ObsidianInstance): Promise<string> {
  return await o.eval<string>(`document.querySelector(${JSON.stringify(REVIEW)})?.innerText ?? ""`);
}

function footer(o: ObsidianInstance) {
  return o.win.locator(".geode-missing-foot");
}

test("601 UI shots: the large set (1,850 of 2,400) across notice, status icon, menu, settings and the review window", async () => {
  test.setTimeout(25 * 60_000);
  const { server, settings } = await seedServer();
  const set = mockupSet("large");
  const vaultDir = await mkdtemp(path.join(tmpdir(), "geode-601-large-"));
  // Identical content: one blob for the whole seed keeps the upload fast, and the review only
  // ever shows paths and counts.
  await writeSeedVault(vaultDir, [...set.held, ...set.rest], () => "# note\n");

  let o = await launchObsidian({
    geodeSettings: settings,
    unlockPassphrase: PASSPHRASE,
    vaultDir,
    keepVaultDir: true,
  });

  try {
    await waitForUnlocked(o);
    await waitTracked(o, set.held.length + set.rest.length);
    await waitForStatusBar(o.win, "Geode: synced", 120_000);

    o = await restartHeld(o, set.held, set.held.length, PASSPHRASE);
    // The approved tooltip has no "Geode:" prefix, so read the attribute, not the shared helper.
    await expect(o.win.locator('[data-testid="geode-statusbar"]')).toHaveAttribute(
      "title",
      "1,850 files missing. Sync is on hold.",
      { timeout: 60_000 },
    );

    /* 601-01: the detection notice, clicked to open the review. */
    const notice = o.win.locator(".notice").last();
    await expect(notice).toContainText("1,850 files missing. Sync is on hold. Click to review.");
    await notice.screenshot({ path: shotPath("601-01-notice.png") });
    await notice.click();
    await expect(o.win.locator(REVIEW)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => readReview(o)).toContain("Review missing files");
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(REVIEW)).toHaveCount(0);
    expect(await o.eval<number>(`${HOLD}?.files.length ?? 0`)).toBe(1850);

    /* 601-02: the status bar's own on-hold state. */
    const status = o.win.locator('[data-testid="geode-statusbar"]');
    await expect(status).toHaveClass(/geode-statusbar-hold/);
    await expect(status).toHaveAttribute("title", "1,850 files missing. Sync is on hold.");
    expect(await status.locator("svg").getAttribute("class")).toContain("file-warning");
    const box = (await status.boundingBox())!;
    await clearNotices(o);
    await o.win.screenshot({
      path: shotPath("601-02-status-icon-on-hold.png"),
      clip: { x: Math.max(0, box.x - 240), y: box.y - 4, width: 260, height: box.height + 8 },
    });

    /* 601-03: the menu: Review missing files first, and it opens the same window. */
    await status.click();
    const menu = o.win.locator(".menu").last();
    await expect(menu).toBeVisible({ timeout: 10_000 });
    await expect(menu.locator(".menu-item-title").first()).toHaveText("Review missing files");
    await expect(menu.locator(".menu-item-title")).toHaveText([
      "Review missing files",
      "Pause",
      "Sync activity",
      "Conflicts",
      "Deleted files",
      "Devices",
      "Geode settings",
    ]);
    await menu.screenshot({ path: shotPath("601-03-menu-on-hold.png") });
    await menu.locator(".menu-item", { hasText: "Review missing files" }).click();
    await expect(o.win.locator(REVIEW)).toBeVisible({ timeout: 10_000 });
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(REVIEW)).toHaveCount(0);

    /* 601-04: the settings row, its Review opens the review window. */
    await openSettingsTab(o);
    const holdRow = o.win.locator('[data-testid="geode-settings-hold-banner"]');
    await expect(holdRow).toBeVisible();
    await expect(holdRow).toContainText("Sync on hold");
    await expect(holdRow).toContainText("1,850 files missing");
    // The same review is inside the Trash section while held; the hold is not an outage.
    const trashHold = o.win.locator('[data-testid="geode-settings-trash-hold"]');
    await expect(trashHold).toBeVisible();
    await expect(trashHold).toContainText("1,850 files missing");
    await expect(trashHold).toContainText("Sync is on hold");
    await expect(o.win.locator('[data-testid="geode-settings-error-banner"]')).toHaveCount(0);
    // A version refresh used to empty the banner container and drop the hold row with it.
    await o.eval(`app.plugins.plugins.geode.onServerVersion("0.0.1"); return true;`);
    await expect(holdRow).toBeVisible();
    await expect(trashHold).toBeVisible();
    await o.eval(
      `app.plugins.plugins.geode.onServerVersion(app.plugins.plugins.geode.manifest.version); return true;`,
    );
    await clearNotices(o);
    await holdRow.screenshot({ path: shotPath("601-04-settings-row.png") });
    await holdRow.locator('[data-testid="geode-settings-review-missing"]').click();
    await expect(o.win.locator(REVIEW)).toBeVisible({ timeout: 10_000 });

    /* 601-05: Folders first, everything off (the whole set restores). */
    await expect.poll(() => readReview(o)).toContain("of 2,400 tracked. Sync is on hold.");
    await expect(o.win.locator('[data-testid="geode-missing-tab-folders"]')).toHaveClass(
      /is-active/,
    );
    await expect(o.win.locator(".geode-missing-tree .tree-item.nav-folder")).toHaveCount(10);
    await expect(o.win.locator(".geode-missing-tree .checkbox-container.is-enabled")).toHaveCount(
      0,
    );
    await expect(footer(o)).toContainText("Restore 1,850 files");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-05-review-folders.png"),
    });

    const folder = (name: string) =>
      o.win.locator(".geode-missing-tree .tree-item-self").filter({
        has: o.win.locator(".tree-item-inner", { hasText: new RegExp(`^${name}$`) }),
      });
    const folderToggle = (pathValue: string) =>
      o.win.locator(`[data-testid="geode-missing-folder-toggle"][data-path="${pathValue}"]`);

    /* 601-06: 2023 selected, Q2 cleared: Archive and 2023 partial, 1,370 to delete. */
    await folderToggle("Archive/2023/").click();
    await folderToggle("Archive/2023/Q2/").click();
    await expect(folder("2023")).toContainText("· partial");
    await expect(folder("Archive")).toContainText("· partial");
    await expect(o.win.locator(".geode-missing-tree .geode-missing-del")).toHaveCount(4);
    await expect(footer(o)).toContainText("Delete 1,370 files, restore 480");
    await expect(o.win.locator('[data-testid="geode-missing-select-all"]')).toHaveClass(
      /is-partial/,
    );
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-06-folders-partial.png"),
    });

    /* 601-07: Recent reflects the folder decision; the switch reads red. */
    await o.win.locator('[data-testid="geode-missing-tab-recent"]').click();
    await expect(o.win.locator(".geode-missing-file")).toHaveCount(1850);
    await expect(o.win.locator(".geode-missing-file-del")).toHaveCount(1370);
    await expect(o.win.locator(".geode-missing-file").first()).toContainText("2026-10-08.md");
    await expect(o.win.locator(".geode-missing-file").first()).toContainText("Daily/");
    await expect(o.win.locator(".geode-missing-file").first()).toContainText("8 Oct 2026");
    // The approved shot frames the first selected row (the top of the list is all kept).
    await o.eval(
      `document.querySelector(".geode-missing-file-del")?.scrollIntoView({ block: "center" }); return true;`,
    );
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-07-recent-reflects-folders.png"),
    });

    /* 601-08: one more Daily note selected in Recent. */
    await o.eval(`document.querySelector(".geode-missing-list").scrollTop = 0; return true;`);
    await o.win.locator('[data-testid="geode-missing-file-toggle"]').first().click();
    await expect(footer(o)).toContainText("Delete 1,371 files, restore 479");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-08-recent-daily-selected.png"),
    });

    /* 601-09: Daily is partial in Folders. */
    await o.win.locator('[data-testid="geode-missing-tab-folders"]').click();
    await expect(folder("Daily")).toContainText("· partial");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-09-folders-daily-partial.png"),
    });

    /* 601-10..12: the three main-button states, footer regions. */
    const selectAll = o.win.locator('[data-testid="geode-missing-select-all"]');
    await selectAll.click(); // partial → all
    await selectAll.click(); // all → none
    await expect(footer(o)).toContainText("Restore 1,850 files");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await footer(o).screenshot({ path: shotPath("601-10-button-restore.png") });

    await folderToggle("Archive/2023/").click();
    await folderToggle("Archive/2023/Q2/").click();
    await expect(footer(o)).toContainText("Delete 1,370 files, restore 480");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await footer(o).screenshot({ path: shotPath("601-11-button-mixed.png") });

    await selectAll.click(); // partial → all
    await expect(footer(o)).toContainText("Delete 1,850 files");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await footer(o).screenshot({ path: shotPath("601-12-button-all.png") });

    /* 601-13: everything selected: header on, every folder dimmed. */
    await expect(o.win.locator(".geode-missing-tree .checkbox-container.is-enabled"))
      .toHaveCount(10);
    await expect(o.win.locator(".geode-missing-tree .geode-missing-del")).toHaveCount(10);
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-13-review-all-selected.png"),
    });

    /* 601-14: the confirmation; Go back keeps the hold and the selection. */
    await o.win.locator('[data-testid="geode-missing-main"]').click();
    const confirm = o.win.locator(".geode-confirm-modal");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator(".modal-container").last()).toContainText(
      "Delete 1,850 files on all devices?",
    );
    await expect(o.win.locator(".modal-container").last()).toContainText(
      "They stay in the trash for 30 days.",
    );
    await expect(o.win.locator('[data-testid="geode-confirm-yes"]')).toHaveText("Delete files");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-14-confirm.png"),
    });
    await o.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(o.win.locator(REVIEW)).toBeVisible();
    expect(
      await o.eval<number>("app.plugins.plugins.geode.pluginSettings.massDeleteHold.files.length"),
    )
      .toBe(1850);
    await o.win.keyboard.press("Escape");
    expect(await o.eval<number>(`${HOLD}?.files.length ?? 0`)).toBe(1850);

    /* Log oracle: the whole run left no error line. */
    const errors = await o.eval<{ level: string; msg: string }[]>(
      "app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === 'error')",
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(await o.consoleErrors()).toEqual([]);
  } finally {
    await o.close().catch(() => {});
    await server.stop();
  }
});

test("601 UI shots: the small set (22 of 60), and delete all resumes sync", async () => {
  test.setTimeout(10 * 60_000);
  const { server, settings } = await seedServer();
  const set = mockupSet("small");
  const vaultDir = await mkdtemp(path.join(tmpdir(), "geode-601-small-"));
  await writeSeedVault(vaultDir, [...set.held, ...set.rest], (f) => `# ${f.path}\n`);

  let o = await launchObsidian({
    geodeSettings: settings,
    unlockPassphrase: PASSPHRASE,
    vaultDir,
    keepVaultDir: true,
  });

  try {
    await waitForUnlocked(o);
    await waitTracked(o, 60);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    o = await restartHeld(o, set.held, 22, PASSPHRASE);
    await expect(o.win.locator(".notice").last()).toContainText(
      "22 files missing. Sync is on hold. Click to review.",
    );
    await clearNotices(o);
    await o.win.locator('[data-testid="geode-statusbar"]').click();
    await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Review missing files" })
      .click();
    await expect(o.win.locator(REVIEW)).toBeVisible({ timeout: 10_000 });

    /* 601-16: 22 of 60, one folder row. */
    await expect.poll(() => readReview(o)).toContain("of 60 tracked. Sync is on hold.");
    await expect(o.win.locator(".geode-missing-tree .tree-item.nav-folder")).toHaveCount(1);
    await expect(o.win.locator(".geode-missing-tree")).toContainText("Scratch");
    await expect(footer(o)).toContainText("Restore 22 files");
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-16-small-folders.png"),
    });

    /* 601-17: Recent lists all 22, newest first. */
    await o.win.locator('[data-testid="geode-missing-tab-recent"]').click();
    await expect(o.win.locator(".geode-missing-file")).toHaveCount(22);
    await expect(o.win.locator(".geode-missing-file").first()).toContainText(
      "Scratchpad 5 Oct.md",
    );
    await clearNotices(o);
    await o.win.mouse.move(2, 2);
    await o.win.locator(".modal-container").last().screenshot({
      path: shotPath("601-17-small-recent.png"),
    });

    /* Delete all 22: one confirmation, then Sync resumed and the files are in the trash. */
    await o.win.locator('[data-testid="geode-missing-select-all"]').click();
    await expect(footer(o)).toContainText("Delete 22 files");
    await o.win.locator('[data-testid="geode-missing-main"]').click();
    await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator(".modal-container").last()).toContainText(
      "Delete 22 files on all devices?",
    );
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();

    /* 601-15: Sync resumed. */
    const resumed = o.win.locator(".notice").last();
    await expect(resumed).toHaveText("Sync resumed", { timeout: 20_000 });
    await resumed.screenshot({ path: shotPath("601-15-resumed.png") });
    await expect(o.win.locator(REVIEW)).toHaveCount(0);
    expect(await o.eval<unknown>(HOLD)).toBe(null);
    expect(await o.eval<number>("app.plugins.plugins.geode.getPendingCount()")).toBe(0);

    for (const file of set.held.slice(0, 22)) {
      expect(
        await o.eval<boolean>(
          `await app.vault.adapter.exists(${JSON.stringify(file.path)})`,
        ),
      ).toBe(false);
    }
    const trash = await o.eval<unknown[]>("await app.plugins.plugins.geode.trash.list()");
    expect(trash.length).toBe(22);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await expect(o.win.locator('[data-testid="geode-statusbar"]')).toHaveClass(
      /geode-statusbar-ok/,
    );
    await expect(o.win.locator('[data-testid="geode-settings-hold-banner"]')).toHaveCount(0);
    await clearNotices(o);

    const errors = await o.eval<{ level: string; msg: string }[]>(
      "app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === 'error')",
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  } finally {
    await o.close().catch(() => {});
    await server.stop();
  }
});
