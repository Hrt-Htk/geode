import { expect, test } from "@playwright/test";
import { type ObsidianInstance } from "../fixtures/obsidian";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import { commitPath, waitForUnlocked, writeVaultFileDirect } from "../helpers/geode";
import { restartHeld } from "../helpers/mass-delete-seed";
import { waitForStatusBar } from "../helpers/waits";
import { readFile } from "node:fs/promises";
import path from "node:path";

// #601: a real mass delete, held by the reconciler, decided in the review window: restore all,
// a mixed decision and delete all. Each test seeds 20 of 30 files in `n/`, deletes that folder
// behind the app's back, restarts, then drives the window; the outcome is asserted on both
// devices and in the server trash.

const PASSPHRASE = "mass-delete-decide-pass";
const FOLDER = Array.from({ length: 20 }, (_, i) => `n/f${String(i).padStart(2, "0")}.md`);
const OTHERS = Array.from({ length: 10 }, (_, i) => `other/g${i}.md`);
const HOLD = "app.plugins.plugins.geode.settings.massDeleteHold";

const content = (file: string) => `# ${file}\n`;

async function seedFiles(o: ObsidianInstance, files: string[]): Promise<void> {
  // Written through the adapter (no vault events), then committed explicitly: the driver decides
  // exactly what the first sync contains.
  for (const file of files) {
    await writeVaultFileDirect(o, file, content(file));
    await commitPath(o, file, "commit");
  }
}

async function waitConverged(o: ObsidianInstance, files: string[]): Promise<void> {
  await expect
    .poll(
      async () =>
        await o.eval<boolean>(
          `(async () => {
            const files = ${JSON.stringify(files)};
            for (const file of files) if (!(await app.vault.adapter.exists(file))) return false;
            return true;
          })()`,
        ),
      { timeout: 120_000 },
    )
    .toBe(true);
}

/** Open the review from the detection notice (the primary entry point). */
async function openReview(o: ObsidianInstance, tracked = 30): Promise<void> {
  const notice = o.win.locator(".notice").last();
  await expect(notice).toContainText("files missing. Sync is on hold. Click to review.");
  await notice.click();
  await expect(o.win.locator(".geode-missing-modal")).toBeVisible({ timeout: 10_000 });
  await expect(o.win.locator(".geode-missing-modal")).toContainText(`of ${tracked} tracked.`);
}

async function confirmDelete(o: ObsidianInstance): Promise<void> {
  await o.win.locator('[data-testid="geode-missing-main"]').click();
  await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
  await o.win.locator('[data-testid="geode-confirm-yes"]').click();
  await expect(o.win.locator(".geode-missing-modal")).toHaveCount(0, { timeout: 60_000 });
  await expect(o.win.locator(".notice").last()).toHaveText("Sync resumed", { timeout: 20_000 });
  expect(await o.eval<unknown>(HOLD)).toBe(null);
}

async function exists(o: ObsidianInstance, file: string): Promise<boolean> {
  return await o.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(file)})`);
}

async function trashCount(o: ObsidianInstance): Promise<number> {
  return await o.eval<number>(
    "(await app.plugins.plugins.geode.trash.list()).length",
  );
}

/** Seed a 30-file vault on A, sync it to B, delete `n/` behind A's back and restart it: A is
 * held on a 20-file mass delete and the review window is open. */
async function withHeldPair(
  fn: (pair: ObsidianPair, A: ObsidianInstance) => Promise<void>,
): Promise<void> {
  const pair = await launchPair({
    passphrase: PASSPHRASE,
    keepVaultA: true,
    settings: { syncObsidianConfig: false },
  });
  let A: ObsidianInstance | null = null;
  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 90_000);
    await seedFiles(pair.A, [...FOLDER, ...OTHERS]);
    await waitConverged(pair.B, [...FOLDER, ...OTHERS]);
    A = await restartHeld(
      pair.A,
      FOLDER.map((path) => ({ path })),
      20,
      PASSPHRASE,
    );
    await openReview(A);
    await fn(pair, A);
  } finally {
    await A?.close().catch(() => {});
    await pair.stop();
  }
}

async function assertSurvived(o: ObsidianInstance, files: string[]): Promise<void> {
  for (const file of files) {
    expect(await exists(o, file), `${file} survives`).toBe(true);
    expect(await o.eval<string>(`await app.vault.adapter.read(${JSON.stringify(file)})`))
      .toBe(content(file));
  }
}

async function assertGone(o: ObsidianInstance, files: string[]): Promise<void> {
  for (const file of files) expect(await exists(o, file), `${file} is gone`).toBe(false);
}

test("601 decide: restore all brings the held folder back on both devices, nothing is trashed", async () => {
  test.slow();
  await withHeldPair(async (pair, A) => {
    await expect(A.win.locator('[data-testid="geode-missing-main"]')).toHaveText(
      "Restore 20 files",
    );
    await A.win.locator('[data-testid="geode-missing-main"]').click();
    await expect(A.win.locator(".notice").last()).toHaveText("Sync resumed", { timeout: 60_000 });
    expect(await A.eval<unknown>(HOLD)).toBe(null);

    await expect.poll(async () => await exists(A, FOLDER[0]), { timeout: 120_000 }).toBe(true);
    await assertSurvived(A, [...FOLDER, ...OTHERS]);
    await expect.poll(async () => await trashCount(A), { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => await exists(pair.B, FOLDER[0]), { timeout: 60_000 }).toBe(true);
    await assertSurvived(pair.B, FOLDER);
    expect(await A.eval<number>("app.plugins.plugins.geode.getPendingCount()")).toBe(0);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    expect(await A.consoleErrors()).toEqual([]);
  });
});

test("601 decide: a mixed decision deletes the selected folder and restores the file kept off", async () => {
  test.slow();
  await withHeldPair(async (pair, A) => {
    // Delete the whole folder, then keep f00 out of it in the Recent list.
    await A.win.locator('[data-testid="geode-missing-folder-toggle"][data-path="n/"]').click();
    await expect(A.win.locator(".geode-missing-foot")).toContainText("Delete 20 files");
    await A.win.locator('[data-testid="geode-missing-tab-recent"]').click();
    await A.win.locator('[data-testid="geode-missing-file-toggle"][data-path="n/f00.md"]').click();
    await expect(A.win.locator(".geode-missing-foot")).toContainText("Delete 19 files, restore 1");
    await confirmDelete(A);

    await assertSurvived(A, ["n/f00.md", ...OTHERS]);
    await assertGone(A, FOLDER.slice(1));
    await expect.poll(async () => await trashCount(A), { timeout: 60_000 }).toBe(19);
    await expect.poll(async () => await exists(pair.B, "n/f00.md"), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => await exists(pair.B, "n/f19.md"), { timeout: 60_000 }).toBe(
      false,
    );
    await assertSurvived(pair.B, OTHERS);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    expect(await A.consoleErrors()).toEqual([]);
  });
});

test("601 decide: delete all confirms once, trashes every held file on both devices", async () => {
  test.slow();
  await withHeldPair(async (pair, A) => {
    await A.win.locator('[data-testid="geode-missing-select-all"]').click();
    await expect(A.win.locator(".geode-missing-foot")).toContainText("Delete 20 files");
    await confirmDelete(A);

    await assertGone(A, FOLDER);
    await assertSurvived(A, OTHERS);
    await expect.poll(async () => await trashCount(A), { timeout: 60_000 }).toBe(20);
    await expect.poll(async () => await exists(pair.B, FOLDER[19]), { timeout: 60_000 })
      .toBe(false);
    await assertGone(pair.B, FOLDER);
    await assertSurvived(pair.B, OTHERS);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    expect(await A.consoleErrors()).toEqual([]);
  });
});

test("601 decide: recovery is refused while the user pause is on, and retries after resume", async () => {
  test.slow();
  await withHeldPair(async (_pair, A) => {
    // Pause sync behind the window, then decide: the window keeps the hold and names the pause.
    await A.eval("await app.plugins.plugins.geode.pauseSync(); return true;");
    await A.win.locator('[data-testid="geode-missing-main"]').click();
    const error = A.win.locator('[data-testid="geode-missing-error"]');
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("Resume sync first");
    expect(await A.eval<number>(`${HOLD}?.files.length ?? 0`)).toBe(20);

    // Resume and retry in the same window: the restore goes through.
    await A.eval("await app.plugins.plugins.geode.resumeSync(); return true;");
    await A.win.locator('[data-testid="geode-missing-main"]').click();
    await expect(A.win.locator(".geode-missing-modal")).toHaveCount(0, { timeout: 120_000 });
    expect(await A.eval<unknown>(HOLD)).toBe(null);
    await expect.poll(async () => await exists(A, FOLDER[0]), { timeout: 120_000 }).toBe(true);
    const source = await readFile(path.join(A.vaultDir, ...FOLDER[0].split("/")), "utf8");
    expect(source).toBe(content(FOLDER[0]));
  });
});

test("601 decide: held root files get their own bottom row and select alone", async () => {
  test.slow();
  const root = "root-note.md";
  const pair = await launchPair({
    passphrase: PASSPHRASE,
    keepVaultA: true,
    settings: { syncObsidianConfig: false },
  });
  let A: ObsidianInstance | null = null;
  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 90_000);
    await seedFiles(pair.A, [...FOLDER, ...OTHERS, root]);
    await waitConverged(pair.B, [...FOLDER, ...OTHERS, root]);
    A = await restartHeld(
      pair.A,
      [...FOLDER.map((path) => ({ path })), { path: root }],
      21,
      PASSPHRASE,
    );
    await openReview(A, 31);

    // The root row is the last tree row, named after the vault, with its own count.
    const rows = A.win.locator(".geode-missing-tree > .tree-item");
    await expect(rows.last()).toContainText(/^Root \(/);
    const rootToggle = rows.last().locator('[data-testid="geode-missing-root-toggle"]');
    await rootToggle.click();
    await expect(A.win.locator(".geode-missing-foot")).toContainText(
      "Delete 1 file, restore 20",
    );
    await confirmDelete(A);

    expect(await exists(A, root)).toBe(false);
    for (const file of FOLDER) expect(await exists(A, file)).toBe(true);
    await expect.poll(async () => await trashCount(A!), { timeout: 60_000 }).toBe(1);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    expect(await A.consoleErrors()).toEqual([]);
  } finally {
    await A?.close().catch(() => {});
    await pair.stop();
  }
});
