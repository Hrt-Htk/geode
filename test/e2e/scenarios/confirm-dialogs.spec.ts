import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #460: confirm dialogs + rename-vault validation. Ports the #445 mockup:
// destructive actions ask first (Resync, Leave), the Leave dialog names the
// vault, Cancel/Escape does nothing, and rename validates inline (empty, 65
// chars) then updates the vault row in place on a valid name.
const PASSPHRASE = "confirm-dialogs-pass";
const VAULT_NAME = "Gate 460 Vault";
const RENAMED_NAME = "Renamed 460";
const SHOT_LEAVE = "460-01-leave.png";
const SHOT_RESYNC = "460-02-resync.png";
const SHOT_RENAME_ERROR = "460-03-rename-error.png";

async function openGeodeSettings(o: ObsidianInstance): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
}

/** Screenshot the topmost modal element (title + body + buttons). */
async function shotModal(o: ObsidianInstance, name: string): Promise<void> {
  await o.win.locator(".modal-container").last().screenshot({ path: shotPath(name) })
    .catch(async () => {
      await o.win.screenshot({ path: shotPath(name) });
    });
}

async function confirmModalText(o: ObsidianInstance): Promise<{ title: string; message: string }> {
  return await o.eval(`
    (() => {
      const containers = document.querySelectorAll(".modal-container");
      const c = containers[containers.length - 1];
      return {
        title: c?.querySelector(".modal-title")?.textContent ?? "",
        message: c?.querySelector(".geode-confirm-modal p")?.textContent ?? "",
      };
    })()
  `);
}

test("confirms: destructive actions ask first, cancel is a no-op, rename validates and updates the row", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("confirm-dialogs");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Name the vault so the Leave dialog can name it. */
    await obsidian.eval(
      `app.plugins.plugins.geode.onVaultNameResolved(${JSON.stringify(VAULT_NAME)}); return true;`,
    );

    await openGeodeSettings(obsidian);
    await obsidian.win.locator(".geode-advanced-heading").click();
    const leaveBtn = obsidian.win.locator('[data-testid="geode-settings-leave"]');
    const resyncBtn = obsidian.win.locator('[data-testid="geode-settings-resync"]');
    await expect(leaveBtn).toBeVisible({ timeout: 10_000 });
    await expect(resyncBtn).toBeVisible();

    const confirmModal = obsidian.win.locator(".geode-confirm-modal");

    /* ---- 1. Leave dialog names the vault; Cancel keeps it configured ---- */
    await leaveBtn.click();
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });
    const leaveSpec = await confirmModalText(obsidian);
    expect(leaveSpec.title).toBe(`Leave ${VAULT_NAME}?`);
    expect(leaveSpec.message).toBe(
      "Disconnects this device and clears its local sync state. Your notes stay.",
    );

    /* The destructive button must not be the default focus. */
    const focusedTestid = await obsidian.eval<string>(
      `document.activeElement?.getAttribute?.("data-testid") ?? ""`,
    );
    expect(focusedTestid).not.toBe("geode-confirm-yes");

    await shotModal(obsidian, SHOT_LEAVE);

    /* Cancel: modal closes, still configured. */
    await obsidian.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirmModal).not.toBeVisible({ timeout: 10_000 });
    await expect(leaveBtn).toBeVisible();
    await expect(obsidian.win.locator('[data-testid="geode-settings-run-wizard"]')).toHaveCount(0);

    /* Escape also cancels with no effect. */
    await leaveBtn.click();
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });
    await obsidian.win.keyboard.press("Escape");
    await expect(confirmModal).not.toBeVisible({ timeout: 10_000 });
    await expect(obsidian.win.locator('[data-testid="geode-settings-run-wizard"]')).toHaveCount(0);
    await expect(leaveBtn).toBeVisible();

    /* ---- 2. Resync now asks first; Cancel does nothing ---- */
    await resyncBtn.click();
    await expect(confirmModal).toBeVisible({ timeout: 10_000 });
    const resyncSpec = await confirmModalText(obsidian);
    expect(resyncSpec.title).toBe("Resync from scratch?");
    expect(resyncSpec.message).toBe("Rebuilds this device's sync state from the server.");
    await shotModal(obsidian, SHOT_RESYNC);

    await obsidian.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirmModal).not.toBeVisible({ timeout: 10_000 });
    /* Cancel means the resync never started: button label untouched, still configured. */
    await expect(resyncBtn).toHaveText("Resync from scratch");
    await expect(obsidian.win.locator('[data-testid="geode-settings-run-wizard"]')).toHaveCount(0);

    /* ---- 3. Rename: empty + 65 chars show inline errors, valid name updates the row ---- */
    const renameBtn = obsidian.win.locator('[data-testid="geode-settings-vault-rename"]');
    await renameBtn.click();
    const renameInput = obsidian.win.locator('[data-testid="geode-vault-rename-input"]');
    const renameConfirm = obsidian.win.locator('[data-testid="geode-vault-rename-confirm"]');
    await expect(renameInput).toBeVisible({ timeout: 10_000 });
    const errorEl = obsidian.win.locator('[data-testid="geode-vault-rename-error"]');

    /* Empty name → inline error. */
    await renameInput.fill("");
    await renameConfirm.click();
    await expect(errorEl).toHaveText("Enter a vault name.");
    await shotModal(obsidian, SHOT_RENAME_ERROR);

    /* 65 chars → inline error. */
    await renameInput.fill("x".repeat(65));
    await renameConfirm.click();
    await expect(errorEl).toHaveText("Use 64 characters or fewer.");

    /* Valid name → modal closes, vault row updates in place. */
    const vaultRow = obsidian.win.locator('[data-testid="geode-settings-vault-name"]');
    const rowBefore = await vaultRow.locator(".setting-item-description").textContent();
    expect(rowBefore).toMatch(new RegExp(`^${VAULT_NAME} · `));
    await renameInput.fill(RENAMED_NAME);
    await renameConfirm.click();
    await expect(renameInput).not.toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => await vaultRow.locator(".setting-item-description").textContent(), {
        timeout: 10_000,
      })
      .toMatch(new RegExp(`^${RENAMED_NAME} · `));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
