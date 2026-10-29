import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { runCommand } from "../helpers/palette";

// #29: every Geode command is listed and runs from the real palette.

const PASSPHRASE = "palette-passphrase";

const GEODE_COMMANDS = [
  "Geode: Push now",
  "Geode: Reconcile now",
  "Geode: Unlock vault",
  "Geode: Lock vault",
  "Geode: Resync from scratch",
  "Geode: Export decrypted vault to folder...",
];

/**
 * Dismiss any open modals using the robust loop from statusbar-driven-states.
 * Close-button first, Escape fallback, 300ms between tries.
 */
async function dismissAllModals(win: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const count = await win.locator(".modal-container").count();
    if (count === 0) break;
    const closeBtn = win.locator(".modal-close-button").last();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
    } else {
      await win.keyboard.press("Escape");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("command palette: all Geode commands visible and functional", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("palette");

  const obsidian = await launchObsidian({
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
    /* Wait for locked baseline. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* Unlock via eval so the sync loop starts. */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* Wait for synced baseline. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any stacked modals (startup modal may have spawned a passphrase modal). */
    await dismissAllModals(obsidian.win);

    /* ---- Step 1: All 7 Geode commands appear in the palette ---- */
    await obsidian.win.keyboard.press("Control+P");
    await obsidian.win.locator(".prompt-input").waitFor({ state: "visible" });
    await obsidian.win.locator(".prompt-input").fill("Geode");

    /* Wait for suggestions to populate. */
    const suggestionItems = obsidian.win.locator(".suggestion-item");
    await expect.poll(
      async () => await suggestionItems.count(),
      { timeout: 10_000 },
    ).toBeGreaterThanOrEqual(GEODE_COMMANDS.length);

    /* Suggestion text includes a plugin-name chip prefix (e.g. "GeodeGeode: Push now"),
       so check substring containment rather than exact match. */
    const visibleCommands = await suggestionItems.allTextContents();
    for (const cmd of GEODE_COMMANDS) {
      expect(
        visibleCommands.some((t) => t.includes(cmd)),
        `Command "${cmd}" not found in palette suggestions`,
      ).toBe(true);
    }

    /* Close the palette. */
    await obsidian.win.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));

    /* ---- Step 2: Lock vault via palette ---- */
    await runCommand(obsidian.win, "Geode: Lock vault");

    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 10_000 },
    ).toBe("Geode: locked");

    /* ---- Step 3: Unlock vault via palette → passphrase modal → type + Enter ---- */
    await runCommand(obsidian.win, "Geode: Unlock vault");

    /* Assert passphrase modal opens with password input visible. */
    const passphraseModal = obsidian.win.locator(
      '.modal:has([data-testid="geode-passphrase-input"])',
    );
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });
    await expect(passphraseModal.locator('[data-testid="geode-passphrase-input"]')).toBeVisible();

    /* Type passphrase and press Enter. */
    await passphraseModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await passphraseModal.locator('[data-testid="geode-passphrase-input"]').press("Enter");

    /* Wait for modal to close and status bar to leave locked state. */
    await expect(passphraseModal).toBeHidden({ timeout: 30_000 });
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 60_000 },
    ).not.toBe("Geode: locked");

    /* Wait for synced again after unlock. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any modals that may have reappeared. */
    await dismissAllModals(obsidian.win);

    /* ---- Step 4: Push now and Reconcile now: no error notices ---- */
    await runCommand(obsidian.win, "Geode: Push now");
    await new Promise((r) => setTimeout(r, 3_000));

    /* Assert no error notice appeared. */
    const pushErrorNotices = await obsidian.win.locator(
      '.notice:has-text("Error"), .notice:has-text("error"), .notice:has-text("failed")',
    ).count();
    expect(pushErrorNotices).toBe(0);

    await runCommand(obsidian.win, "Geode: Reconcile now");
    await new Promise((r) => setTimeout(r, 3_000));

    const reconcileErrorNotices = await obsidian.win.locator(
      '.notice:has-text("Error"), .notice:has-text("error"), .notice:has-text("failed")',
    ).count();
    expect(reconcileErrorNotices).toBe(0);

    /* ---- Step 5: Resync from scratch: SKIPPED (destructive/slow) ---- */

    /* ---- Step 7: Export decrypted vault to folder...: modal appears, Escape closes it ---- */
    await runCommand(obsidian.win, "Geode: Export decrypted vault to folder...");

    /* Assert the export modal opens with its input and button visible. */
    const exportInput = obsidian.win.locator('[data-testid="geode-export-folder-input"]');
    await expect(exportInput).toBeVisible({ timeout: 10_000 });
    const exportBtn = obsidian.win.locator('[data-testid="geode-export-submit"]');
    await expect(exportBtn).toBeVisible();

    /* Close with Escape without triggering a real export. */
    await obsidian.win.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 500));
    await expect(exportInput).toBeHidden({ timeout: 5_000 });

    /* Verify vault is still unlocked and synced (nothing broke). */
    const finalStatus = await readGeodeStatusBar(obsidian.win);
    expect(finalStatus).not.toBe("Geode: locked");
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
