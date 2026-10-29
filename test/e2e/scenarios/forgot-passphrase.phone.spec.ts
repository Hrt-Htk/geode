import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #440 on-device: the forgot modal opens from the locked settings tab, renders
// styled (callout, not a wall of text), and the cancel path keeps the vault.
const PASSPHRASE = "forgot-passphrase-pass";

const FORGOT_MODAL = '.modal:has([data-testid="geode-forgot-callout"])';

test("forgot (phone): open from the locked tab, screenshot, cancel path", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const SHOT_FORGOT = shotPath("440-phone-01-forgot");

  const server = await useRemoteServer();
  const device = await server.mintToken("forgot-passphrase-phone");

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
    /* connectPhone starts locked. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");
    await dismissModals(obsidian);

    /* Open the settings tab (no leading close on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return "ok";
    `);
    await obsidian.win.locator('[data-testid="geode-settings-sync-status"]').waitFor({
      timeout: 15_000,
    });
    await expect(obsidian.win.locator('[data-testid="geode-settings-forgot"]')).toBeVisible({
      timeout: 10_000,
    });

    /* Forgot link on the locked tab opens the modal. */
    await evalClick(obsidian, '[data-testid="geode-settings-forgot"]');
    const forgotModal = obsidian.win.locator(FORGOT_MODAL).last();
    await expect(forgotModal).toBeVisible({ timeout: 10_000 });
    await expect(forgotModal.locator('[data-testid="geode-forgot-callout"]')).toContainText(
      "No one can reset your passphrase.",
    );
    await expect(forgotModal.locator('[data-testid="geode-forgot-hint"]')).toContainText(
      "Check your other devices first. One may still be unlocked.",
    );

    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(SHOT_FORGOT);

    /* Cancel path: "Got it" closes the modal, vault stays locked and configured. */
    await evalClick(obsidian, '[data-testid="geode-forgot-got-it"]');
    await expect(forgotModal).not.toBeVisible({ timeout: 5_000 });
    expect(await readGeodeStatusBar(obsidian.win)).toBe("Geode: locked");
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-sync-status"]'),
    ).toBeVisible({ timeout: 10_000 });

    /* Vault is still configured: unlock through the real path to prove it survived. */
    await evalClick(obsidian, '[data-testid="geode-settings-unlock"]');
    const unlockModal = obsidian.win.locator('.modal:has([data-testid="geode-passphrase-input"])')
      .last();
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-passphrase-input"]').value = ${
        JSON.stringify(PASSPHRASE)
      }; return true;`,
    );
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');
    await expect(unlockModal).not.toBeVisible({ timeout: 30_000 });
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
