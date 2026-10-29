import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { runCommand } from "../helpers/palette";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";

// #29: on-device: every Geode command is listed and runs from the palette.

const PASSPHRASE = "palette-passphrase";

const GEODE_COMMANDS = [
  "Geode: Push now",
  "Geode: Reconcile now",
  "Geode: Unlock vault",
  "Geode: Lock vault",
  "Geode: Resync from scratch",
  "Geode: Export decrypted vault to folder...",
];

test("command palette: all Geode commands visible and functional", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("palette");

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
    await dismissModals(obsidian);

    /* ---- Step 1: All 7 Geode commands appear in the palette ---- */
    await obsidian.eval(`app.commands.executeCommandById("command-palette:open")`);
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
    await dismissModals(obsidian);
    await runCommand(obsidian.win, "Geode: Unlock vault");

    /* Assert passphrase modal opens with password input visible. */
    const passphraseModal = obsidian.win.locator(
      '.modal:has([data-testid="geode-passphrase-input"])',
    ).last();
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });
    await expect(passphraseModal.locator('[data-testid="geode-passphrase-input"]')).toBeVisible();

    /* Type passphrase and click Unlock (press Enter doesn't fire keyup on Android WebView password inputs). */
    await evalSetValue(obsidian, '[data-testid="geode-passphrase-input"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');

    /* Wait for modal to close and status bar to leave locked state. */
    await expect(passphraseModal).not.toBeVisible({ timeout: 30_000 });
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 60_000 },
    ).not.toBe("Geode: locked");

    /* Wait for synced again after unlock. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Dismiss any modals that may have reappeared. */
    await dismissModals(obsidian);

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

    /* Close it without triggering a real export (Escape doesn't fire on the mobile WebView). */
    await dismissModals(obsidian);
    await expect(exportInput).not.toBeVisible({ timeout: 5_000 });

    /* Verify vault is still unlocked and synced (nothing broke). */
    const finalStatus = await readGeodeStatusBar(obsidian.win);
    expect(finalStatus).not.toBe("Geode: locked");
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
