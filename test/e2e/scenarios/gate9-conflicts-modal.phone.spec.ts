import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { expectFits } from "../helpers/fit";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate9-conflicts-modal-passphrase";
// A folder path, so the row shows its second line (the folder) too.
const ORIGINAL_PATH = "Notes/debug-test.md";
const CONFLICT_PATH = "Notes/debug-test.conflict-2026-07-07T10-00-00.md";
// A real two sided diff: both sides changed the shared line, and only the
// conflict file carries the extra paragraph.
const ORIGINAL_BODY = `# Plan\n\nFirst paragraph.\n\nShared line.\n\nLast paragraph.`;
const CONFLICT_BODY =
  `# Plan\n\nFirst paragraph.\n\nShared line with a different ending.\n\nAn extra paragraph only the conflict has.\n\nLast paragraph.`;

// #434: phone mirror of gate9-conflicts-modal: the Conflicts modal (#432)
// lists a seeded conflict file, Review opens the colored comparison (#435) and
// it fits the screen, Back returns to the list, Open both opens the file (new
// tab on phones), and a version that went away under the list is reported
// instead of offered for keeping.

test("gate9 conflicts modal lists conflict files, reviews and opens them", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("gate9-conflicts-modal");

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
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );
    /* Wait for vault unlocked and synced */
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian, "Geode: synced", 60_000);
    // The device keeps its DOM between specs: start from no open modal.
    await dismissModals(obsidian);

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
    const list = obsidian.win.locator(".geode-conflicts-modal");
    const row = obsidian.win.locator("[data-testid=geode-conflict-row]");
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    // The row names the ORIGINAL file (the conflict file is the "Open both" side).
    await expect(row.locator(".geode-conflict-name")).toHaveText("debug-test.md");
    // The folder sits under the name, smaller and muted.
    await expect(row.locator(".geode-conflict-folder")).toHaveText("Notes/");
    await expectFits(list);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("435-phone-04-list-folder.png"));

    /* 3. Review: the two versions compared, and it fits the phone screen. */
    await evalClick(obsidian, "[data-testid=geode-conflict-review]");
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
    const diff = review.locator("[data-testid=geode-conflict-diff]");
    await expect(diff).toContainText("Shared line with a different ending.");
    await expect(diff).toContainText("An extra paragraph only the conflict has.");
    await expectFits(review);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("435-phone-01-review.png"));

    /* 4. Back returns to the list; the conflict is still open. */
    await evalClick(obsidian, "[data-testid=geode-conflict-back]");
    await expect(review).not.toBeVisible();
    await expect(row).toHaveCount(1);

    /* 5. Open both (phone: new tab + the conflict file is opened). */
    await evalClick(obsidian, "[data-testid=geode-conflict-open-both]");
    await expect
      .poll(
        async () =>
          await obsidian.eval<boolean>(
            `app.workspace.getLeavesOfType("markdown").some((l) => l.view?.file?.path === ${
              JSON.stringify(CONFLICT_PATH)
            })`,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

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

    /* 7. A version can go away between the list and the review (another device
       resolved it): the review says so and offers only Back. */
    await obsidian.eval(`
      await app.vault.create(${JSON.stringify(ORIGINAL_PATH)}, ${JSON.stringify(ORIGINAL_BODY)});
      await app.vault.create(${JSON.stringify(CONFLICT_PATH)}, ${JSON.stringify(CONFLICT_BODY)});
      return true;
    `);
    await obsidian.eval(`app.plugins.plugins.geode.openConflictsModal(); return true;`);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    // Delete and open the review in one turn, so no list reload can drop the row first.
    await obsidian.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(CONFLICT_PATH)});
      if (file) await app.vault.delete(file);
      document.querySelector('[data-testid="geode-conflict-review"]').click();
      return true;
    `);
    const goneReview = obsidian.win.locator(".geode-conflict-review-modal");
    await expect(goneReview.locator("[data-testid=geode-conflict-gone]")).toHaveText(
      "This conflict is no longer here.",
    );
    await expect(goneReview.locator("[data-testid=geode-conflict-keep-original]")).toHaveCount(0);
    await expect(goneReview.locator("[data-testid=geode-conflict-keep-both]")).toHaveCount(0);
    await expect(goneReview.locator("[data-testid=geode-conflict-back]")).toHaveCount(1);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("435-phone-05-gone.png"));
    await evalClick(obsidian, "[data-testid=geode-conflict-back]");
    await expect(goneReview).not.toBeVisible();
    await dismissModals(obsidian);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
