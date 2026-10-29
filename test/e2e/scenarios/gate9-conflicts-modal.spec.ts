import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate9-conflicts-modal-passphrase";
// A folder path, so the row shows its second line (the folder) too.
const ORIGINAL_PATH = "Notes/debug-test.md";
const CONFLICT_PATH = "Notes/debug-test.conflict-2026-07-07T10-00-00.md";
// A real two sided diff: both sides changed the shared line, and only the
// conflict file carries the extra paragraph.
const ORIGINAL_BODY = `# Plan

First paragraph.

Shared line.

Last paragraph.`;
const CONFLICT_BODY = `# Plan

First paragraph.

Shared line with a different ending.

An extra paragraph only the conflict has.

Last paragraph.`;

// #434: the debug pane is gone; conflict files now surface in the Conflicts
// modal (#432). Same coverage: the modal lists a seeded conflict file, Review
// opens the colored comparison (#435), Open both opens the file.

test("gate9 conflicts modal lists conflict files, reviews and opens them", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("gate9-conflicts-modal");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    /* Wait for vault unlocked and synced */
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* 1. Open the Conflicts modal: initially no conflict rows. */
    await obsidian.eval(`app.plugins.plugins.geode.openConflictsModal(); return true;`);
    await expect(obsidian.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 10_000 });
    await expect(obsidian.win.locator("[data-testid=geode-conflicts-empty]")).toBeVisible();
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-conflicts-done"]')?.click(); return true;`,
    );
    await expect(obsidian.win.locator(".geode-conflicts-modal")).not.toBeVisible();

    /* 2. Seed a real conflict pair (original + conflict file), then reopen the
       modal: the row appears. */
    await obsidian.eval(`
      await app.vault.createFolder("Notes").catch(() => {});
      await app.vault.create(${JSON.stringify(ORIGINAL_PATH)}, ${JSON.stringify(ORIGINAL_BODY)});
      await app.vault.create(${JSON.stringify(CONFLICT_PATH)}, ${JSON.stringify(CONFLICT_BODY)});
      return true;
    `);
    await obsidian.eval(`app.plugins.plugins.geode.openConflictsModal(); return true;`);
    const row = obsidian.win.locator("[data-testid=geode-conflict-row]");
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    // The row names the ORIGINAL file (the conflict file is the "Open both" side).
    await expect(row.locator(".geode-conflict-name")).toHaveText("debug-test.md");
    // The folder sits under the name, smaller and muted.
    await expect(row.locator(".geode-conflict-folder")).toHaveText("Notes/");
    await obsidian.win.locator(".geode-conflicts-modal").screenshot({
      path: shotPath("435-06-list-folder.png"),
    });

    /* 3. Review: the two versions compared, each side in its own color. */
    await row.locator("[data-testid=geode-conflict-review]").click();
    const review = obsidian.win.locator(".geode-conflict-review-modal");
    await expect(review).toBeVisible({ timeout: 10_000 });
    await expect(review.locator("[data-testid=geode-conflict-key-original]")).toContainText(
      "Original",
    );
    await expect(review.locator("[data-testid=geode-conflict-key-conflict]")).toContainText(
      "Conflict",
    );
    await expect(
      review.locator('[data-testid=geode-conflict-diff-line][data-kind="same"]').first(),
    ).toHaveText("# Plan");
    // Only the original has this line as it was; the conflict rewrote it and
    // added a paragraph the original never had.
    await expect(
      review.locator('[data-testid=geode-conflict-diff-line][data-kind="original"]'),
    ).toHaveText("Shared line.");
    const diff = review.locator("[data-testid=geode-conflict-diff]");
    await expect(diff).toContainText("Shared line with a different ending.");
    await expect(diff).toContainText("An extra paragraph only the conflict has.");
    // The plugin inherits the app theme: shoot the review in both, dark first.
    const darkClasses = await obsidian.eval<string>(`
      app.changeTheme("obsidian");
      await new Promise((r) => setTimeout(r, 500));
      return document.body.className;
    `);
    expect(darkClasses).toContain("theme-dark");
    await review.screenshot({ path: shotPath("435-01-review.png") });

    /* 3b. The same comparison in the light theme: the two version colors must
       stay readable on white (AA), not just on the dark default. */
    const lightClasses = await obsidian.eval<string>(`
      app.changeTheme("moonstone");
      await new Promise((r) => setTimeout(r, 500));
      return document.body.className;
    `);
    expect(lightClasses).toContain("theme-light");
    await review.screenshot({ path: shotPath("435-07-review-light.png") });
    await obsidian.eval(`app.changeTheme("obsidian"); return true;`);

    /* 4. Back returns to the list; the conflict is still open. */
    await review.locator("[data-testid=geode-conflict-back]").click();
    await expect(review).not.toBeVisible();
    await expect(row).toHaveCount(1);

    /* 5. Open both (manual merge path): the conflict file becomes the active file. */
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-conflict-open-both"]')?.click(); return true;`,
    );
    await expect
      .poll(
        async () =>
          await obsidian.eval<string | null>(
            "app.workspace.getActiveFile()?.path ?? null",
          ),
        { timeout: 15_000 },
      )
      .toBe(CONFLICT_PATH);

    /* 6. Delete the conflict pair and reopen: the list is empty again. */
    await obsidian.eval(`
      for (const p of [${JSON.stringify(CONFLICT_PATH)}, ${JSON.stringify(ORIGINAL_PATH)}]) {
        const file = app.vault.getAbstractFileByPath(p);
        if (file) await app.vault.delete(file);
      }
      return true;
    `);
    await obsidian.eval(
      `document.querySelector('.geode-conflicts-modal .modal-close-button')?.click(); return true;`,
    );
    await obsidian.eval(`app.plugins.plugins.geode.openConflictsModal(); return true;`);
    await expect(obsidian.win.locator("[data-testid=geode-conflicts-empty]")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
