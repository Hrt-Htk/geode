import { expect, test } from "@playwright/test";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForContent, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #432/#435: the Conflicts view end to end on two real devices: a real conflict is
// made (B pauses, A commits, B edits, B resumes → 3-way merge → conflict file),
// the calmer git-merge orange icon + "Conflicts (1)" menu badge + settings
// [Review] row all show the same count, and each resolution (Keep original with
// a Cancel first, Keep both, Keep conflict) converges on the other device with
// the count back to zero, the icon back to synced, and an activity line
// recorded. The resolutions run in the review window (#435), which names the
// two files by device with a date and a time.

const PASSPHRASE = "conflicts-flow-pass";
// One file per conflict so a resolution's post-state never affects the next.
const PATH = "gate432.md";
const PATH_B = "gate432b.md";
const PATH_C = "gate432c.md";
const PATH_D = "gate432d.md";
const BASE = "line 1\nline 2\nline 3";

const STATUSBAR = '[data-testid="geode-statusbar"]';
// Both the new "(conflict <device> <stamp>)" form (HHMM or HHMMSS) and the old
// ".conflict-<stamp>" form.
const CONFLICT_FILE =
  /(\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}|\(conflict .+? \d{4}-\d{2}-\d{2} \d{4,6}( \d+)?\))\.\w+$/;

type Dev = ObsidianPair["A"];

async function poll<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  what: string,
  timeoutMs = 45_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** B pauses, A commits a new version of `path`, B edits the same line, B resumes → conflict on B.
 * Each conflict uses its own file so a resolution's post-state never affects the next one. */
async function makeConflict(
  A: Dev,
  B: Dev,
  path: string,
  aEdit: string,
  bEdit: string,
): Promise<string> {
  // The file must exist on BOTH devices with a common base, or B's divergent
  // edit is a fresh create that the apply overwrites instead of conflicting.
  const existsOnA = await A.eval<boolean>(`app.vault.adapter.exists(${JSON.stringify(path)})`);
  if (!existsOnA) {
    await upsertVaultFile(A, path, BASE);
    await waitForContent(A, B, path, BASE);
  }
  const before = await A.eval<number>(
    `app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(path)})?.last_seen_version ?? 0`,
  );
  await B.eval(`app.plugins.plugins.geode.pauseSync(); return true;`);
  await upsertVaultFile(A, path, aEdit);
  await poll(
    () =>
      A.eval<number>(
        `app.plugins.plugins.geode.state.getLocalFile(${
          JSON.stringify(path)
        })?.last_seen_version ?? 0`,
      ),
    (v) => v > before,
    "A's commit to land on the server",
  );
  await upsertVaultFile(B, path, bEdit);
  await B.eval(`app.plugins.plugins.geode.resumeSync(); return true;`);
  // Only one conflict file exists at a time (each is resolved before the next
  // is created), so the pattern alone identifies it.
  return poll(
    () =>
      B.eval<string | null>(
        `app.vault.getFiles().map((f) => f.path).find((p) => ${CONFLICT_FILE.toString()}.test(p)) ?? null`,
      ),
    (p) => p !== null,
    `the conflict file for ${path} on B`,
  );
}

async function conflictFilesOn(dev: Dev): Promise<string[]> {
  return await dev.eval<string[]>(
    `Array.from(app.vault.getFiles()).map((f) => f.path).filter((p) => ${CONFLICT_FILE.toString()}.test(p))`,
  );
}

async function assertResolved(
  A: Dev,
  B: Dev,
  path: string,
  conflictPath: string,
  originalContent: string,
): Promise<void> {
  await waitForContent(A, B, path, originalContent);
  for (const dev of [A, B]) {
    await poll(
      async () => (await conflictFilesOn(dev)).includes(conflictPath),
      (present) => present === false,
      `conflict file gone on ${dev === A ? "A" : "B"}`,
    );
  }
  await waitForStatusBar(B.win, "Geode: synced", 60_000);
  await expect(B.win.locator(STATUSBAR)).toHaveClass(/geode-statusbar-ok/);
  await expect(B.win.locator(STATUSBAR)).not.toHaveClass(/geode-statusbar-conflict/);
}

test("conflicts: real conflict, calmer icon, menu badge, review row, modal resolves", async () => {
  test.slow();
  const { A, B, stop } = await launchPair({ passphrase: PASSPHRASE });
  try {
    await waitForUnlocked(A);
    await waitForUnlocked(B);
    await A.eval(
      `app.plugins.plugins.geode.settings.deviceName = "Laptop A"; await app.plugins.plugins.geode.saveSettings(); return true;`,
    );
    await B.eval(
      `app.plugins.plugins.geode.settings.deviceName = "Laptop B"; await app.plugins.plugins.geode.saveSettings(); return true;`,
    );
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    await waitForStatusBar(B.win, "Geode: synced", 60_000);

    await upsertVaultFile(A, PATH, BASE);
    await waitForContent(A, B, PATH, BASE);

    /* ── Conflict 1: icon, menu badge, modal row, Keep theirs (Cancel first) ── */
    const conflict1 = await makeConflict(
      A,
      B,
      PATH,
      "line 1\nA edited line 2\nline 3",
      "line 1\nB edited line 2\nline 3",
    );
    await waitForStatusBar(B.win, "Geode: 1 conflict", 30_000);
    await expect(B.win.locator(STATUSBAR)).toHaveClass(/geode-statusbar-conflict/);
    const iconClass = await B.win.locator(`${STATUSBAR} svg`).getAttribute("class");
    expect(iconClass).toContain("lucide-git-merge");

    // Menu: "Conflicts (1)" in mockup order.
    await B.win.locator(STATUSBAR).click();
    await expect(B.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
    const titles = await B.win.locator(".menu").last().locator(".menu-item-title")
      .allTextContents();
    expect(titles).toEqual([
      "Pause",
      "Sync activity",
      "Conflicts (1)",
      "Deleted files",
      "Devices",
      "Geode settings",
    ]);
    await B.win.locator(".menu").last().screenshot({ path: shotPath("432-01-menu-conflicts.png") });

    // Open the modal from the menu entry.
    await B.win.locator(".menu").last().locator(".menu-item", { hasText: "Conflicts (1)" }).click();
    await expect(B.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    const row = B.win.locator("[data-testid=geode-conflict-row]");
    await expect(row).toHaveCount(1);
    // The compact row: the file name on its own line, the folder under it.
    await expect(row.locator(".geode-conflict-name")).toHaveText("gate432.md");
    await B.win.locator(".geode-conflicts-modal").screenshot({
      path: shotPath("435-02-list.png"),
    });

    // Review: the two files as the key, named by device (never IDs) with a date
    // and a time. On B the conflict file holds B's own set aside edit, the
    // original holds the version A reached the server with first.
    await row.locator("[data-testid=geode-conflict-review]").click();
    const review = B.win.locator(".geode-conflict-review-modal");
    await expect(review).toBeVisible({ timeout: 10_000 });
    await expect(review.locator("[data-testid=geode-conflict-key-original]")).toContainText(
      "Original",
    );
    await expect(review.locator("[data-testid=geode-conflict-key-conflict]")).toContainText(
      "Conflict",
    );
    await expect(review.locator("[data-testid=geode-conflict-key-conflict]")).toContainText(
      "Laptop B",
    );
    // The remote name lands when the device list fetch resolves, so poll for it.
    await expect(review.locator("[data-testid=geode-conflict-key-original]")).toContainText(
      "device-A",
      { timeout: 15_000 },
    );
    // Line 1 and 3 are in both versions, line 2 was changed on each side.
    await expect(
      review.locator('[data-testid=geode-conflict-diff-line][data-kind="same"]'),
    ).toHaveCount(2);
    await expect(
      review.locator('[data-testid=geode-conflict-diff-line][data-kind="original"]'),
    ).toHaveText("A edited line 2");
    await review.screenshot({ path: shotPath("435-03-review.png") });

    // Keep original is destructive: confirm, Cancel first, then confirm for real.
    await review.locator("[data-testid=geode-conflict-keep-original]").click();
    const confirmModal = B.win.locator(".modal", { has: B.win.locator(".geode-confirm-modal") });
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });
    await expect(confirmModal).toContainText("Keep device-A's version?");
    await B.win.locator("[data-testid=geode-confirm-cancel]").click();
    await expect(B.win.locator(".geode-confirm-modal")).not.toBeVisible();
    // Cancelled: the review stays open and the conflict is still listed.
    await expect(review).toBeVisible();
    await expect(row).toHaveCount(1, { timeout: 10_000 });

    await review.locator("[data-testid=geode-conflict-keep-original]").click();
    await B.win.locator("[data-testid=geode-confirm-yes]").click();
    await expect(
      B.win.locator(".notice", { hasText: "Resolved · kept device-A's version" }),
    ).toBeVisible({ timeout: 10_000 });
    // Resolved: the review closes back to the list, which is now empty.
    await expect(review).not.toBeVisible({ timeout: 15_000 });
    await assertResolved(A, B, PATH, conflict1, "line 1\nA edited line 2\nline 3");
    // Close the Conflicts modal so its backdrop doesn't block the statusbar.
    await B.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(B.win.locator(".geode-conflicts-modal")).not.toBeVisible();

    // The resolution left an activity line.
    await B.win.locator(STATUSBAR).click();
    await B.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
    await expect(B.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 10_000 });
    await expect(B.win.locator(".geode-activity-modal")).toContainText(
      "Resolved · kept device-A's version",
    );
    await B.win.keyboard.press("Escape");
    await expect(B.win.locator(".geode-activity-modal")).not.toBeVisible();

    /* ── Conflict 2: settings [Review] row, Keep both renames beside the original ── */
    const conflict2 = await makeConflict(
      A,
      B,
      PATH_B,
      "line 1\nA second edit\nline 3",
      "line 1\nB second edit\nline 3",
    );
    await waitForStatusBar(B.win, "Geode: 1 conflict", 30_000);

    await B.eval(
      `app.setting.open(); app.setting.openTabById(app.plugins.plugins.geode.manifest.id); return true;`,
    );
    const statusRow = B.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect(statusRow).toBeVisible({ timeout: 10_000 });
    await expect(statusRow).toContainText("1 conflict to review");
    const reviewBtn = B.win.locator('[data-testid="geode-settings-review"]');
    await expect(reviewBtn).toBeVisible();
    await B.win
      .locator('[data-testid="geode-settings-sync-status"]')
      .screenshot({ path: shotPath("432-03-settings-review-row.png") });
    await reviewBtn.click();
    await expect(B.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    await expect(B.win.locator("[data-testid=geode-conflict-row]")).toHaveCount(1, {
      timeout: 10_000,
    });

    // Keep both is non-destructive: no confirm, the conflict file is renamed.
    await B.win.locator("[data-testid=geode-conflict-review]").click();
    const reviewB = B.win.locator(".geode-conflict-review-modal");
    await expect(reviewB).toBeVisible({ timeout: 10_000 });
    await reviewB.locator("[data-testid=geode-conflict-keep-both]").click();
    await expect(B.win.locator(".notice", { hasText: "kept both" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(reviewB).not.toBeVisible({ timeout: 15_000 });
    const kept = "gate432b (kept copy).md";
    await waitForContent(A, B, kept, "line 1\nB second edit\nline 3");
    for (const dev of [A, B]) {
      await poll(
        async () => (await conflictFilesOn(dev)).includes(conflict2),
        (present) => present === false,
        `conflict file gone on ${dev === A ? "A" : "B"}`,
      );
    }
    await waitForStatusBar(B.win, "Geode: synced", 60_000);
    // Close the Conflicts modal (opened via [Review]) so it doesn't block the
    // next statusbar click, then close the settings tab.
    await B.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(B.win.locator(".geode-conflicts-modal")).not.toBeVisible();
    await B.eval(`app.setting?.close?.(); return true;`);

    /* ── Conflict 3: Keep mine, then the empty state and the plain menu badge ── */
    const conflict3 = await makeConflict(
      A,
      B,
      PATH_C,
      "line 1\nA third edit\nline 3",
      "line 1\nB third edit\nline 3",
    );
    await waitForStatusBar(B.win, "Geode: 1 conflict", 30_000);

    await B.win.locator(STATUSBAR).click();
    await B.win.locator(".menu").last().locator(".menu-item", { hasText: "Conflicts (1)" }).click();
    await expect(B.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    // Keep conflict keeps the file that holds B's own set aside edit.
    await B.win.locator("[data-testid=geode-conflict-review]").click();
    const reviewC = B.win.locator(".geode-conflict-review-modal");
    await expect(reviewC).toBeVisible({ timeout: 10_000 });
    await reviewC.locator("[data-testid=geode-conflict-keep-conflict]").click();
    const confirmMine = B.win.locator(".modal", { has: B.win.locator(".geode-confirm-modal") });
    await expect(confirmMine).toContainText("Keep Laptop B's version?");
    await B.win.locator("[data-testid=geode-confirm-yes]").click();
    await expect(
      B.win.locator(".notice", { hasText: "Resolved · kept Laptop B's version" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(reviewC).not.toBeVisible({ timeout: 15_000 });
    await assertResolved(A, B, PATH_C, conflict3, "line 1\nB third edit\nline 3");
    // Close the Conflicts modal so its backdrop doesn't block the statusbar.
    await B.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(B.win.locator(".geode-conflicts-modal")).not.toBeVisible();

    // Count is back to zero: the menu badge is plain and the modal is empty.
    await B.win.locator(STATUSBAR).click();
    await expect(B.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
    const finalTitles = await B.win
      .locator(".menu")
      .last()
      .locator(".menu-item-title")
      .allTextContents();
    expect(finalTitles).toContain("Conflicts");
    expect(finalTitles).not.toContain("Conflicts (1)");
    await B.win.locator(".menu").last().locator(".menu-item", { hasText: "Conflicts" }).click();
    await expect(B.win.locator("[data-testid=geode-conflicts-empty]")).toBeVisible({
      timeout: 10_000,
    });
    await B.win.locator(".geode-conflicts-modal").screenshot({
      path: shotPath("432-04-modal-empty.png"),
    });
    await B.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(B.win.locator(".geode-conflicts-modal")).not.toBeVisible();

    /* ── Conflict 4: resolved on the RECEIVING device A (the actions invert) ── */
    const conflict4 = await makeConflict(
      A,
      B,
      PATH_D,
      "line 1\nA fourth edit\nline 3",
      "line 1\nB fourth edit\nline 3",
    );
    await waitForStatusBar(B.win, "Geode: 1 conflict", 30_000);
    // The conflict file syncs to A (its creator is B).
    await poll(
      async () => await conflictFilesOn(A),
      (files) => files.includes(conflict4),
      "conflict file to reach the receiving device A",
    );
    // The count derives from the conflict files present in the vault, so the
    // receiving device shows the same badge as the creator: orange icon,
    // "Conflicts (1)" menu entry and the settings [Review] row.
    await waitForStatusBar(A.win, "Geode: 1 conflict", 30_000);
    await expect(A.win.locator(STATUSBAR)).toHaveClass(/geode-statusbar-conflict/);
    await A.win.locator(STATUSBAR).click();
    const aTitles = await A.win.locator(".menu").last().locator(".menu-item-title")
      .allTextContents();
    expect(aTitles).toContain("Conflicts (1)");
    await A.win.locator(".menu").last().screenshot({ path: shotPath("432-06-menu-receiving.png") });
    await A.win.locator(".menu").last().locator(".menu-item", { hasText: "Conflicts (1)" }).click();
    await expect(A.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    const rowA = A.win.locator("[data-testid=geode-conflict-row]");
    await expect(rowA).toHaveCount(1, { timeout: 10_000 });
    // The conflict file is the creator's (Laptop B); the original is A's copy.
    await rowA.locator("[data-testid=geode-conflict-review]").click();
    const reviewA = A.win.locator(".geode-conflict-review-modal");
    await expect(reviewA).toBeVisible({ timeout: 10_000 });
    await expect(reviewA.locator("[data-testid=geode-conflict-key-original]")).toContainText(
      "Laptop A",
    );
    await expect(reviewA.locator("[data-testid=geode-conflict-key-conflict]")).toContainText(
      "Laptop B",
      { timeout: 15_000 },
    );
    await reviewA.screenshot({ path: shotPath("435-04-review-receiving.png") });
    await reviewA.locator("[data-testid=geode-conflict-back]").click();
    await expect(reviewA).not.toBeVisible();
    await A.win.locator(".geode-conflicts-modal").screenshot({
      path: shotPath("435-05-list-receiving.png"),
    });
    // The settings [Review] row reads the same count.
    await A.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(A.win.locator(".geode-conflicts-modal")).not.toBeVisible();
    await A.eval(
      `app.setting.open(); app.setting.openTabById(app.plugins.plugins.geode.manifest.id); return true;`,
    );
    const aStatusRow = A.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect(aStatusRow).toContainText("1 conflict to review");
    await expect(A.win.locator('[data-testid="geode-settings-review"]')).toBeVisible();
    await A.win.locator('[data-testid="geode-settings-sync-status"]').screenshot({
      path: shotPath("432-07-settings-receiving.png"),
    });
    await A.win.locator('[data-testid="geode-settings-review"]').click();
    await expect(A.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    await expect(A.win.locator("[data-testid=geode-conflict-row]")).toHaveCount(1, {
      timeout: 10_000,
    });
    // Keep conflict on A keeps the creator's version (inverted from B): write the
    // conflict file over the original and commit it.
    await A.win.locator("[data-testid=geode-conflict-review]").click();
    const reviewA2 = A.win.locator(".geode-conflict-review-modal");
    await expect(reviewA2).toBeVisible({ timeout: 10_000 });
    await reviewA2.locator("[data-testid=geode-conflict-keep-conflict]").click();
    const confirmA = A.win.locator(".modal", { has: A.win.locator(".geode-confirm-modal") });
    await expect(confirmA).toBeVisible({ timeout: 10_000 });
    await expect(confirmA).toContainText("Keep Laptop B's version?");
    await A.win.locator("[data-testid=geode-confirm-yes]").click();
    await expect(
      A.win.locator(".notice", { hasText: "Resolved · kept Laptop B's version" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(reviewA2).not.toBeVisible({ timeout: 15_000 });
    await assertResolved(A, B, PATH_D, conflict4, "line 1\nB fourth edit\nline 3");
    await A.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(A.win.locator(".geode-conflicts-modal")).not.toBeVisible();
    await A.eval(`app.setting?.close?.(); return true;`);
    // Resolved on either device clears the badge on BOTH: A is back to synced
    // with a plain "Conflicts" menu entry.
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    await expect(A.win.locator(STATUSBAR)).not.toHaveClass(/geode-statusbar-conflict/);
    await A.win.locator(STATUSBAR).click();
    const aFinalTitles = await A.win.locator(".menu").last().locator(".menu-item-title")
      .allTextContents();
    expect(aFinalTitles).toContain("Conflicts");
    expect(aFinalTitles).not.toContain("Conflicts (1)");
    await A.win.locator(".menu").last().locator(".menu-item", { hasText: "Conflicts" }).click();
    await expect(A.win.locator("[data-testid=geode-conflicts-empty]")).toBeVisible({
      timeout: 10_000,
    });
    await A.win.locator("[data-testid=geode-conflicts-done]").click();
    await expect(A.win.locator(".geode-conflicts-modal")).not.toBeVisible();
  } finally {
    await stop();
  }
});
