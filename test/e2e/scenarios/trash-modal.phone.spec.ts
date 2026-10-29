import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { expectFits } from "../helpers/fit";
import { shotPath } from "../helpers/shots";
import { IN_FLOOR_PURGE_ASK, IN_FLOOR_PURGE_CANCELLED } from "../../../plugin/ui/trash-format";

// #461: trash modal on the phone: opened from the status-menu bottom sheet as
// a full-screen modal (.is-mobile), rows render, the toolbar fits (#638), and a
// deleted note previews.
const PASSPHRASE = "trash-pass";
const NOTE_PATH = "notes/phone-preview.md";
const CONTENT = "# Phone note\nPreview from the phone.\n";
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

test("trash modal (phone): full screen from the menu, preview a note", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("phone");
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
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Create + delete a note so the trash holds one entry ---- */
    await upsertVaultFile(obsidian, NOTE_PATH, CONTENT);
    await commitPath(obsidian, NOTE_PATH, "commit");
    await obsidian.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
      if (!file) throw new Error("expected file to delete");
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(obsidian, NOTE_PATH, "delete");
    await expect
      .poll(
        async () =>
          await obsidian.eval<number>(
            "(await app.plugins.plugins.geode.trash.list()).length",
          ),
        { timeout: 30_000 },
      )
      .toBe(1);

    /* ---- Menu → Deleted files opens the full-screen modal ---- */
    await tapMenu(obsidian);
    await tapMenuItem(obsidian, "Deleted files");
    const modal = obsidian.win.locator(".geode-trash-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("phone-preview.md");

    // Full screen on .is-phone: the modal fills the viewport.
    const box = await modal.boundingBox();
    const vp = obsidian.win.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan((vp?.width ?? 0) * 0.8);
    expect(box!.height).toBeGreaterThan((vp?.height ?? 0) * 0.8);

    // #638: the toolbar must fit the screen: no control past the modal, no
    // sideways scroll. Idle: Select all + the retention note + two actions.
    await expectFits(modal);

    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("461-phone-01-trash.png"));

    // Selected: the toolbar now also holds the count, Restore selected and
    // Purge selected (1): it still fits.
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-trash-select-all"]').click(); return true;`,
    );
    await expect(obsidian.win.locator('[data-testid="geode-trash-count"]')).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-trash-purge-selected"]')).toBeVisible();
    await expectFits(modal);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("461-phone-03-trash-selected.png"));

    /* ---- #677: purging inside the retention floor asks for the admin token. The prompt
       fits the phone, and dismissing it deletes nothing. ---- */
    await evalClick(obsidian, '[data-testid="geode-trash-purge-selected"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');
    const prompt = obsidian.win.locator(".geode-admin-token-modal");
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText(IN_FLOOR_PURGE_ASK);
    await expectFits(prompt);
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("677-phone-01-admin-prompt.png"));

    /* The auto-focused input raises the soft keyboard over the prompt's footer. BACK hides the
       keyboard (the prompt stays), so the Cancel/Continue row is on screen and reachable. */
    await obsidian.back();
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await obsidian.screenshot(shotPath("677-phone-02-admin-prompt-actions.png"));

    /* Cancel through the prompt's own button: nothing is purged, and the plain message says so. */
    await obsidian.eval(`
      const buttons = [...document.querySelectorAll(".geode-admin-token-modal button")];
      const cancel = buttons.find((b) => b.textContent === "Cancel");
      if (!cancel) throw new Error("expected a Cancel button on the admin token prompt");
      cancel.click();
      return true;
    `);
    await expect(prompt).toHaveCount(0, { timeout: 10_000 });
    await expect(obsidian.win.locator(".notice").last()).toContainText(IN_FLOOR_PURGE_CANCELLED, {
      timeout: 10_000,
    });
    await obsidian.screenshot(shotPath("677-phone-03-cancelled-notice.png"));
    expect(await obsidian.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"))
      .toBe(1);

    /* ---- Preview the note: markdown renders ---- */
    const hash = await obsidian.eval<string>(
      "(await app.plugins.plugins.geode.trash.list())[0].path_hash",
    );
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-trash-view"][data-path-hash=${
        JSON.stringify(hash)
      }]').click(); return true;`,
    );
    const md = obsidian.win.locator('[data-testid="geode-preview-markdown"]');
    await expect(md).toBeVisible({ timeout: 15_000 });
    await expect(md).toContainText("Preview from the phone");
    await obsidian.screenshot(shotPath("461-phone-02-preview.png"));
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
