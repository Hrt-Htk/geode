import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { expectFits } from "../helpers/fit";
import { shotPath } from "../helpers/shots";

// #432/#435: the Conflicts modal on the real phone: a conflict file seeded in
// the vault shows one compact row (file name, folder), Review opens the colored
// comparison with Original / Conflict as the key, and Back returns to the list
// with the conflict still open. The modal list is disk-based (scans for
// isConflictPath files), so a seeded pair exercises the real render path.
const PASSPHRASE = "conflicts-flow-pass";
const ORIGINAL = "gate432.md";
// The real naming form: "<stem> (conflict <device> <date> <time>).<ext>" (#432), so the
// original path is recoverable from the name.
const CONFLICT = "gate432 (conflict Phone 2026-10-14 1405).md";
// Both sides rewrote the shared line and only the conflict file has the extra
// paragraph, so the review screen shows a real two sided diff.
const ORIGINAL_BODY = "# Plan\n\nFirst paragraph.\n\nShared line.\n\nLast paragraph.";
const CONFLICT_BODY =
  "# Plan\n\nFirst paragraph.\n\nShared line with a different ending.\n\nAn extra paragraph only the conflict has.\n\nLast paragraph.";

const MOBILE = '[data-testid="geode-mobile-status"]';

async function tapMenu(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`document.querySelector(${JSON.stringify(MOBILE)}).click(); return true;`);
  await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
    timeout: 10_000,
  });
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

test("conflicts modal (phone): one compact row per conflict, reviewed and left open", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("conflicts-flow");
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
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    // Seed the original + its conflict file so the disk-based list has one row.
    await obsidian.eval(`
      await app.vault.create(${JSON.stringify(ORIGINAL)}, ${JSON.stringify(ORIGINAL_BODY)});
      await app.vault.create(${JSON.stringify(CONFLICT)}, ${JSON.stringify(CONFLICT_BODY)});
      return true;
    `);

    /* ---- Menu → Conflicts → the modal shows the seeded row ---- */
    await tapMenu(obsidian);
    // The badge derives from the conflict files in the vault, so the seeded
    // conflict bumps the menu entry to "Conflicts (1)" on this device too.
    await expect.poll(
      async () =>
        await obsidian.eval<string[]>(
          `Array.from(document.querySelectorAll(".menu .menu-item-title")).map((el) => el.textContent || "")`,
        ),
      { timeout: 15_000 },
    ).toContain("Conflicts (1)");
    await tapMenuItem(obsidian, "Conflicts (1)");
    const list = obsidian.win.locator(".geode-conflicts-modal");
    await expect(list).toBeVisible({ timeout: 15_000 });
    const row = obsidian.win.locator("[data-testid=geode-conflict-row]");
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    // The file name on its own line, the folder under it.
    await expect(row.locator(".geode-conflict-name")).toHaveText("gate432.md");
    await expectFits(list);
    // Every action in the row is a real touch target on a phone.
    const rowTargets = await obsidian.win
      .locator("[data-testid=geode-conflict-row] button, [data-testid=geode-conflict-row] a")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(Math.min(...rowTargets)).toBeGreaterThanOrEqual(40);

    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("435-phone-02-list.png"));

    /* ---- Review: the two versions with their colors as the key ---- */
    await evalClick(obsidian, "[data-testid=geode-conflict-review]");
    const review = obsidian.win.locator(".geode-conflict-review-modal");
    await expect(review).toBeVisible({ timeout: 15_000 });
    // Both versions' names carry a date and a time, never a bare clock time.
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
    const reviewTargets = await review
      .locator("button")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(Math.min(...reviewTargets)).toBeGreaterThanOrEqual(40);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("435-phone-03-review.png"));

    /* ---- Back: the review closes and the row stays listed ---- */
    await evalClick(obsidian, "[data-testid=geode-conflict-back]");
    await expect(review).not.toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveCount(1);
    // The device keeps its DOM between specs: never leave a modal open for the next one.
    await dismissModals(obsidian);
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
