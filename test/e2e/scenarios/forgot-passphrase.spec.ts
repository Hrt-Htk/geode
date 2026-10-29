import { expect, test } from "@playwright/test";
import { launchObsidian, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { shotPath } from "../helpers/shots";
import { waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { computeVerifier } from "../helpers/verifier";

// #440: unlock pop-up + forgot-passphrase flow, ported from mockup #442.
// Unlock: inline error on a wrong passphrase, "Unlocking…" working label, forgot
// link under the field. Forgot: honest callout, device hint, "Try again" back to
// the pop-up, "Start a new vault from my notes" through the #460 confirm family
// → leave path (local notes untouched) → setup wizard. Link on the locked tab and
// the wizard Join step.
const PASSPHRASE = "forgot-passphrase-pass";

const UNLOCK_MODAL = '.modal:has([data-testid="geode-passphrase-input"])';
const FORGOT_MODAL = '.modal:has([data-testid="geode-forgot-callout"])';

test("forgot: unlock pop-up, forgot modal, try again, new vault from notes", async () => {
  test.slow();

  const SHOT_UNLOCK_WRONG = shotPath("440-01-unlock-wrong");
  const SHOT_FORGOT = shotPath("440-02-forgot-modal");
  const SHOT_CONFIRM = shotPath("440-03-confirm-new-vault");
  const SHOT_WIZARD_JOIN = shotPath("440-04-wizard-join");

  const server = await startServer();
  const device = await server.mintToken("forgot-passphrase");

  /* A real verifier so a wrong passphrase actually fails checkVerifier. */
  const verifier = await computeVerifier(
    PASSPHRASE,
    server.salt,
    { ops: TEST_ARGON2_PARAMS.ops, mem: TEST_ARGON2_PARAMS.mem },
  );

  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      verifier,
      argon2Params: TEST_ARGON2_PARAMS,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* Open the settings tab on the Geode tab and keep it open. */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    await o.win.locator('[data-testid="geode-settings-sync-status"]').waitFor({ timeout: 15_000 });

    /* ---- Lock, then open the unlock pop-up from the locked tab ---- */
    await o.win.locator('[data-testid="geode-settings-lock"]').click();
    await expect(o.win.locator('[data-testid="geode-settings-unlock"]')).toBeVisible({
      timeout: 10_000,
    });
    await o.win.locator('[data-testid="geode-settings-forgot"]').waitFor({ timeout: 10_000 });

    await o.win.locator('[data-testid="geode-settings-unlock"]').click();
    const unlockModal = o.win.locator(UNLOCK_MODAL);
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await expect(unlockModal.locator('[data-testid="geode-passphrase-forgot"]')).toBeVisible();

    /* ---- Wrong passphrase: inline error, modal stays open, vault stays locked ---- */
    await unlockModal.locator('[data-testid="geode-passphrase-input"]').fill(
      "definitely-wrong-passphrase",
    );
    await unlockModal.locator('[data-testid="geode-passphrase-submit"]').click();
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    await expect(unlockModal.locator('[data-testid="geode-passphrase-error"]')).toContainText(
      "That passphrase doesn't match this vault.",
    );
    expect(await readGeodeStatusBar(o.win)).toBe("Geode: locked");

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(UNLOCK_MODAL).screenshot({ path: SHOT_UNLOCK_WRONG });

    /* ---- Forgot link in the pop-up: pop-up closes, forgot modal opens ---- */
    await unlockModal.locator('[data-testid="geode-passphrase-forgot"]').click();
    const forgotModal = o.win.locator(FORGOT_MODAL);
    await expect(forgotModal).toBeVisible({ timeout: 10_000 });
    await expect(unlockModal).not.toBeVisible();
    await expect(forgotModal.locator('[data-testid="geode-forgot-callout"]')).toContainText(
      "No one can reset your passphrase.",
    );
    await expect(forgotModal.locator('[data-testid="geode-forgot-hint"]')).toContainText(
      "Check your other devices first. One may still be unlocked.",
    );

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(FORGOT_MODAL).screenshot({ path: SHOT_FORGOT });

    /* ---- "Try again" returns to the unlock pop-up ---- */
    await forgotModal.locator('[data-testid="geode-forgot-try-again"]').click();
    await expect(forgotModal).not.toBeVisible({ timeout: 5_000 });
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });

    /* ---- Correct passphrase unlocks ---- */
    await unlockModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await unlockModal.locator('[data-testid="geode-passphrase-submit"]').click();
    await expect(unlockModal).not.toBeVisible({ timeout: 30_000 });
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* ---- Lock again; forgot link on the locked tab opens the modal ---- */
    await o.win.locator('[data-testid="geode-settings-lock"]').click();
    await expect(o.win.locator('[data-testid="geode-settings-unlock"]')).toBeVisible({
      timeout: 10_000,
    });

    await o.win.locator('[data-testid="geode-settings-forgot"]').click();
    await expect(o.win.locator(FORGOT_MODAL)).toBeVisible({ timeout: 10_000 });

    /* "Try again" from the tab also lands on the unlock pop-up. */
    await o.win.locator('[data-testid="geode-forgot-try-again"]').click();
    await expect(o.win.locator(UNLOCK_MODAL)).toBeVisible({ timeout: 10_000 });
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(UNLOCK_MODAL)).not.toBeVisible({ timeout: 5_000 });

    /* ---- "Start a new vault from my notes" asks for confirmation; Cancel keeps the vault ---- */
    await o.win.locator('[data-testid="geode-settings-forgot"]').click();
    await expect(o.win.locator(FORGOT_MODAL)).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-forgot-new-vault"]').click();
    const confirmModal = o.win.locator(".modal:has(.geode-confirm-modal)");
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });
    await expect(confirmModal.locator(".modal-title")).toContainText(
      "Start a new vault from your notes?",
    );

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".geode-confirm-modal").screenshot({ path: SHOT_CONFIRM });

    await o.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirmModal).not.toBeVisible({ timeout: 5_000 });

    /* The forgot modal is still open behind the confirm; close it. */
    await o.win.locator('[data-testid="geode-forgot-got-it"]').click();
    await expect(o.win.locator(FORGOT_MODAL)).not.toBeVisible({ timeout: 5_000 });
    expect(await readGeodeStatusBar(o.win)).toBe("Geode: locked");
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toBeVisible();

    /* ---- Confirm: leave the vault, notes stay on disk, setup wizard opens ---- */
    await o.eval(`await app.vault.adapter.write("note.md", "keep me"); return true;`);

    await o.win.locator('[data-testid="geode-settings-forgot"]').click();
    await expect(o.win.locator(FORGOT_MODAL)).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-forgot-new-vault"]').click();
    await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();

    /* Confirm closes the forgot modal; the wizard opens on top of the locked tab. */
    await expect(o.win.locator(FORGOT_MODAL)).not.toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-settings-run-wizard"]').waitFor({ timeout: 15_000 });
    expect(await o.eval<boolean>("app.vault.adapter.exists('note.md')")).toBe(true);

    /* The setup wizard opened at its Choose step. */
    const wizard = o.win.locator('.modal:has([data-testid="geode-wizard-join"])');
    await expect(wizard).toBeVisible({ timeout: 10_000 });

    /* ---- Wizard Join step shows the forgot link ---- */
    await wizard.locator('[data-testid="geode-wizard-join"]').click();
    await o.win.locator('[data-testid="geode-join-server"]').waitFor({ timeout: 10_000 });
    await o.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);
    await o.win.locator('[data-testid="geode-join-vault-select"]').waitFor({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-join-forgot"]')).toBeVisible();

    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator('.modal:has([data-testid="geode-join-vault-select"])').first().screenshot({
      path: SHOT_WIZARD_JOIN,
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
