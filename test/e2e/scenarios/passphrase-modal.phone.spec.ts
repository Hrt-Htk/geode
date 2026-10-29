import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { computeVerifier } from "../helpers/verifier";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";

// #29: on-device: the passphrase modal's empty, wrong, escape and correct paths.

const PASSPHRASE = "passphrase-modal-test";

test("passphrase modal: empty, wrong, escape, and correct passphrase paths", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("passphrase-modal");

  /* Compute a real verifier so unlockVault exercises the actual checkVerifier path. */
  const verifier = await computeVerifier(
    PASSPHRASE,
    server.salt,
    { ops: TEST_ARGON2_PARAMS.ops, mem: TEST_ARGON2_PARAMS.mem },
  );

  /* Launch a configured instance that starts LOCKED.
     keepStartupModal: true → the plugin auto-opens a PassphraseModal at startup.
     A real verifier is seeded, so unlockVault runs checkVerifier against production code. */
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      verifier,
      argon2Params: TEST_ARGON2_PARAMS,
    },
    keepStartupModal: true,
  });

  try {
    /* Wait for locked state. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* Dismiss ALL modals immediately. Obsidian auto-opens its Settings dialog
       on fresh test vaults, overlaying the startup passphrase modal and intercepting
       clicks (see helpers/geode.ts focusSetupWizard). Dismissing both gives us a
       clean slate; we then open a passphrase modal via command for determinism,
       the same pattern used in every subsequent step. */
    await dismissModals(obsidian);

    /* Open a fresh passphrase modal via the unlock command. */
    await obsidian.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);
    const passphraseModal = obsidian.win.locator(
      '.modal:has([data-testid="geode-passphrase-input"])',
    ).last();
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });

    /* ---- Step 1: Assert modal structure ---- */
    const passwordInput = passphraseModal.locator('[data-testid="geode-passphrase-input"]');
    const unlockButton = passphraseModal.locator('[data-testid="geode-passphrase-submit"]');
    await expect(passwordInput).toBeVisible();
    await expect(unlockButton).toBeVisible();

    /* ---- Step 2: Empty submit: click Unlock with empty input ---- */
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');
    await new Promise((r) => setTimeout(r, 500));

    /* Modal remains open (empty guard returns early without closing). */
    await expect(passphraseModal).toBeVisible();
    /* Inline error is shown for empty passphrase. */
    await expect(passphraseModal.locator('[data-testid="geode-passphrase-error"]')).toContainText(
      "Passphrase is required.",
    );
    /* Vault still locked. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 5_000 },
    ).toBe("Geode: locked");

    /* ---- Step 3: Wrong passphrase ---- */
    /* With a real verifier seeded, typing a wrong passphrase exercises the
       real unlockVault → checkVerifier path: checkVerifier returns false,
       unlockVault resets keys/isUnlocked and throws.
       passphrase-modal.ts submit() catches the throw, shows inline error,
       clears the field, and keeps the modal open.
       Observable behavior:
       1. The modal STAYS OPEN
       2. An inline error appears ("That passphrase doesn't match this vault.")
       3. The password field is cleared
       4. Vault stays locked */

    /* Close the current modal and reopen a fresh one. */
    await dismissModals(obsidian);

    /* Reopen the passphrase modal via the unlock command. */
    await obsidian.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);

    const wrongModal = obsidian.win.locator('.modal:has([data-testid="geode-passphrase-input"])')
      .last();
    await expect(wrongModal).toBeVisible({ timeout: 10_000 });

    /* Type wrong passphrase and click Unlock. */
    await evalSetValue(
      obsidian,
      '[data-testid="geode-passphrase-input"]',
      "definitely-wrong-passphrase",
    );
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');
    await new Promise((r) => setTimeout(r, 1000));

    /* Observable behavior (matching real unlockVault + PassphraseModal interaction):
       1. The modal STAYS OPEN: unlockVault throws, submit() catch block keeps it open. */
    await expect(wrongModal).toBeVisible({ timeout: 10_000 });

    /* 2. Inline error is shown. */
    await expect(wrongModal.locator('[data-testid="geode-passphrase-error"]')).toContainText(
      "That passphrase doesn't match this vault.",
    );

    /* 3. Password field is cleared. */
    const inputVal = await wrongModal.locator('[data-testid="geode-passphrase-input"]')
      .inputValue();
    expect(inputVal).toBe("");

    /* 4. Vault stays locked. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 5_000 },
    ).toBe("Geode: locked");

    /* ---- Step 4: Escape/cancel ---- */
    /* The Step 3 wrong-passphrase modal is still open (fix keeps it open): close it first. */
    await dismissModals(obsidian);

    /* Reopen the modal and close it with Escape. */
    await obsidian.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);

    const escapeModal = obsidian.win.locator('.modal:has([data-testid="geode-passphrase-input"])')
      .last();
    await expect(escapeModal).toBeVisible({ timeout: 10_000 });

    /* Cancel the modal (Escape doesn't fire on the mobile WebView: dismiss via close button). */
    await dismissModals(obsidian);

    /* Modal should be closed. */
    await expect(escapeModal).not.toBeVisible({ timeout: 5_000 });

    /* Vault still locked. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 5_000 },
    ).toBe("Geode: locked");

    /* ---- Step 5: Correct passphrase via Enter key ---- */
    /* Reopen the modal. */
    await obsidian.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);

    const correctModal = obsidian.win.locator('.modal:has([data-testid="geode-passphrase-input"])')
      .last();
    await expect(correctModal).toBeVisible({ timeout: 10_000 });

    /* Type the correct passphrase and click Unlock.
       (press Enter doesn't fire keyup on Android WebView password inputs.) */
    await evalSetValue(obsidian, '[data-testid="geode-passphrase-input"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');

    /* Wait for the modal to close (unlockVault resolves → submit() calls close()). */
    await expect(correctModal).not.toBeVisible({ timeout: 30_000 });

    /* Vault unlocks and connects. Wait for status bar to settle to a stable state.
       Use waitForStatusBar (polling helper) instead of an eager read: after leaving
       "locked" the bar can show "Geode: pushing (N)" mid-sync before reaching synced. */
    const statusText = await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    expect(statusText).toMatch(/^Geode: synced/);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
