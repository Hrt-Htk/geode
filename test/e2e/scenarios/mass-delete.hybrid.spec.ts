import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { waitForUnlocked } from "../helpers/geode";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { expectFits } from "../helpers/fit";
import {
  deleteSeedFiles,
  mockupSet,
  waitForHold,
  writeSeedVault,
} from "../helpers/mass-delete-seed";
import { waitForStatusBar } from "../helpers/waits";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// #601: the held mass-delete review on the real Android device (hybrid: the phone is A, the
// desktop B keeps the server's copies). Files disappear while the plugin is not watching, so
// the next session's first reconciler pass trips the guard: that is the real detection path.
//
// Two tests: the approved phone shots on the mockup's 1,850 / 2,400 set, and the decision
// (delete all) on the small set so the on-device verdict stays fast.

const PASSPHRASE = "mass-delete-phone-pass";
const HOLD = "app.plugins.plugins.geode.settings.massDeleteHold";

test.describe.configure({ timeout: 45 * 60_000 });

/** Delete the held files while the plugin is disabled, then re-enable it and unlock: the fresh
 * session's first pass sees the unpaired deletes (a restart in the product's terms). */
async function tripHold(
  phone: { eval: <T>(js: string) => Promise<T> },
  held: string[],
): Promise<void> {
  await phone.eval(`
    await app.plugins.disablePlugin("geode");
    for (const file of ${JSON.stringify(held)}) {
      await app.vault.adapter.remove(file);
    }
    await app.plugins.enablePlugin("geode");
    return true;
  `);
  await phone.eval(`
    const g = app.plugins.plugins.geode;
    if (!g.isUnlockedCheck()) await g.unlockVault(${JSON.stringify(PASSPHRASE)});
    return true;
  `);
  await expect
    .poll(() => phone.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"), {
      timeout: 120_000,
    })
    .toBe(true);
}

function reviewText(phone: { eval: <T>(js: string) => Promise<T> }) {
  return phone.eval<string>(
    `document.querySelector(".geode-missing-modal")?.innerText ?? ""`,
  );
}

function footerText(phone: { eval: <T>(js: string) => Promise<T> }) {
  return phone.eval<string>(
    `document.querySelector(".geode-missing-foot")?.innerText ?? ""`,
  );
}

async function clearNotices(phone: { eval: <T>(js: string) => Promise<T> }): Promise<void> {
  await phone.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
}

test("601 phone shots: the review at real scale on the 1,850 of 2,400 set", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  const set = mockupSet("large");
  const seedDir = await mkdtemp(path.join(tmpdir(), "geode-601-phone-large-"));
  // Identical content dedupes to one blob; the shots only read paths and counts.
  await writeSeedVault(seedDir, [...set.held, ...set.rest], () => "# note\n");

  const pair = await launchHybridPair({
    passphrase: PASSPHRASE,
    phoneAsA: true,
    settings: { syncObsidianConfig: false },
    seedFromVault: { sourceDir: seedDir, count: 2400 },
  });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A, "Geode: synced", 40 * 60_000);
    await waitForStatusBar(pair.B, "Geode: synced", 5 * 60_000);
    expect(await pair.A.fileExists(set.held[0].path)).toBe(true);
    await tripHold(pair.A, set.held.map((f) => f.path));
    await waitForHold(pair.A, 1850, 10 * 60_000);

    /* 601-18: the detection notice on the phone says Tap. */
    const noticeText = await pair.A.eval<string>(
      `document.querySelectorAll(".notice")[document.querySelectorAll(".notice").length - 1]?.innerText ?? ""`,
    );
    expect(noticeText.trim()).toBe("1,850 files missing. Sync is on hold. Tap to review.");
    await pair.A.screenshot("601-18-mobile-notice.png");

    /* 601-19: the settings row: Review opens the review window. */
    await clearNotices(pair.A);
    await pair.A.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await expect
      .poll(
        () =>
          pair.A.eval<boolean>(
            `!!document.querySelector('[data-testid="geode-settings-hold-banner"]')`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await pair.A.screenshot("601-19-mobile-settings-row.png");
    // #638: the Trash trigger row must fit the phone too: two number fields, a unit after each.
    await expectFits(pair.A.win.locator('[data-testid="geode-settings-mass-delete"]'));
    await evalClick(pair.A, '[data-testid="geode-settings-review-missing"]');
    await expect
      .poll(() => pair.A.eval<boolean>("!!document.querySelector('.geode-missing-modal')"), {
        timeout: 30_000,
      })
      .toBe(true);
    await pair.A.eval("new Promise((r) => setTimeout(r, 800)); return true;");

    /* 601-20: Folders, 1,850 of 2,400, everything kept. */
    expect(await reviewText(pair.A)).toContain("of 2,400 tracked. Sync is on hold.");
    expect(
      await pair.A.eval<number>(
        `document.querySelectorAll(".geode-missing-tree .tree-item.nav-folder").length`,
      ),
    )
      .toBe(10);
    expect(await footerText(pair.A)).toContain("Restore 1,850 files");
    await expectFits(pair.A.win.locator(".geode-missing-modal"));
    await clearNotices(pair.A);
    await pair.A.screenshot("601-20-mobile-review-folders.png");

    /* 601-21: Recent, same order and dates as the mockup (mtimes survived the seed). */
    await evalClick(pair.A, '[data-testid="geode-missing-tab-recent"]');
    await expect
      .poll(() => pair.A.eval<number>(`document.querySelectorAll(".geode-missing-file").length`))
      .toBe(1850);
    const firstRow = await pair.A.eval<string>(
      `document.querySelector(".geode-missing-file")?.innerText ?? ""`,
    );
    expect(firstRow).toContain("2026-10-08.md");
    expect(firstRow).toContain("Daily/");
    expect(firstRow).toContain("8 Oct 2026");
    await expectFits(pair.A.win.locator(".geode-missing-modal"));
    await clearNotices(pair.A);
    await pair.A.screenshot("601-21-mobile-review-recent.png");

    /* 601-23: the mixed state: Archive selected, Q2 kept off. */
    await evalClick(pair.A, '[data-testid="geode-missing-tab-folders"]');
    await evalClick(
      pair.A,
      '[data-testid="geode-missing-folder-toggle"][data-path="Archive/2023/"]',
    );
    await evalClick(
      pair.A,
      '[data-testid="geode-missing-folder-toggle"][data-path="Archive/2023/Q2/"]',
    );
    await expect.poll(() => footerText(pair.A)).toContain("Delete 1,370 files, restore 480");
    await expectFits(pair.A.win.locator(".geode-missing-modal"));
    await clearNotices(pair.A);
    await pair.A.screenshot("601-23-mobile-mixed.png");

    /* 601-24: all selected: the header switch turns the partial state on. */
    await evalClick(pair.A, '[data-testid="geode-missing-select-all"]');
    await expect.poll(() => footerText(pair.A)).toContain("Delete 1,850 files");
    await expectFits(pair.A.win.locator(".geode-missing-modal"));
    await clearNotices(pair.A);
    await pair.A.screenshot("601-24-mobile-all.png");

    /* 601-22: the confirmation for the whole set. */
    await evalClick(pair.A, '[data-testid="geode-missing-main"]');
    await pair.A.eval("new Promise((r) => setTimeout(r, 800)); return true;");
    const confirmText = await pair.A.eval<string>(
      `(() => { const all = [...document.querySelectorAll(".modal-container")]; return all[all.length - 1]?.innerText ?? ""; })()`,
    );
    expect(confirmText).toContain("Delete 1,850 files on all devices?");
    expect(confirmText).toContain("They stay in the trash for 30 days.");
    await expectFits(pair.A.win.locator(".geode-confirm"));
    await clearNotices(pair.A);
    await pair.A.screenshot("601-22-mobile-confirm.png");

    /* Go back keeps the hold; the desktop still holds every file. */
    await evalClick(pair.A, '[data-testid="geode-confirm-cancel"]');
    expect(await pair.A.eval<number>(`${HOLD}?.files.length ?? 0`)).toBe(1850);
    expect(await pair.A.fileExists(set.held[0].path)).toBe(false);
    // Leave the app clean for the decision test that runs next in the same worker.
    await pair.A.eval(`
      const close = document.querySelectorAll(".modal-close-button");
      close[close.length - 1]?.click();
      return true;
    `);
    expect(await pair.B.fileExists(set.held[0].path)).toBe(true);
    expect(await pair.A.consoleErrors()).toEqual([]);
    expect(await pair.B.consoleErrors()).toEqual([]);
  } finally {
    await deleteSeedFiles(seedDir, [...set.held, ...set.rest]);
    await pair.stop();
  }
});

test("601 phone decision: delete all lands on both devices with trash entries", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  const set = mockupSet("small");
  const seedDir = await mkdtemp(path.join(tmpdir(), "geode-601-phone-small-"));
  await writeSeedVault(seedDir, [...set.held, ...set.rest], (f) => `# ${f.path}\n`);

  const pair = await launchHybridPair({
    passphrase: PASSPHRASE,
    phoneAsA: true,
    settings: { syncObsidianConfig: false },
    seedFromVault: { sourceDir: seedDir, count: 60 },
  });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A, "Geode: synced", 5 * 60_000);
    await waitForStatusBar(pair.B, "Geode: synced", 5 * 60_000);
    expect(await pair.A.fileExists(set.held[0].path)).toBe(true);

    await tripHold(pair.A, set.held.map((f) => f.path));
    await waitForHold(pair.A, 22, 3 * 60_000);
    // The previous test may have left a modal open; its review state is not this vault's.
    await dismissModals(pair.A);
    expect(await reviewText(pair.A)).toBe("");
    await pair.A.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await expect
      .poll(
        () =>
          pair.A.eval<boolean>(
            `!!document.querySelector('[data-testid="geode-settings-hold-banner"]')`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await evalClick(pair.A, '[data-testid="geode-settings-review-missing"]');
    await expect
      .poll(() => pair.A.eval<boolean>("!!document.querySelector('.geode-missing-modal')"), {
        timeout: 30_000,
      })
      .toBe(true);
    await pair.A.eval("new Promise((r) => setTimeout(r, 600)); return true;");
    await evalClick(pair.A, '[data-testid="geode-missing-select-all"]');
    await expect.poll(() => footerText(pair.A)).toContain("Delete 22 files");
    await evalClick(pair.A, '[data-testid="geode-missing-main"]');
    await pair.A.eval("new Promise((r) => setTimeout(r, 400)); return true;");
    await evalClick(pair.A, '[data-testid="geode-confirm-yes"]');

    await expect.poll(() => pair.A.eval<unknown>(HOLD), { timeout: 120_000 }).toBe(null);
    await expect
      .poll(() => pair.A.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"), {
        timeout: 120_000,
      })
      .toBe(22);
    for (const file of set.held) {
      await expect.poll(() => pair.A.fileExists(file.path), { timeout: 60_000 }).toBe(false);
      await expect.poll(() => pair.B.fileExists(file.path), { timeout: 120_000 }).toBe(false);
    }
    for (const file of set.rest.slice(0, 5)) {
      expect(await pair.A.fileExists(file.path)).toBe(true);
      expect(await pair.B.fileExists(file.path)).toBe(true);
    }
    await waitForStatusBar(pair.B, "Geode: synced", 120_000);
    expect(await pair.A.consoleErrors()).toEqual([]);
    expect(await pair.B.consoleErrors()).toEqual([]);
  } finally {
    await deleteSeedFiles(seedDir, [...set.held, ...set.rest]);
    await pair.stop();
  }
});
