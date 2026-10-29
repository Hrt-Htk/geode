import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "join-kdf-params-passphrase";
// New vaults derive at the Standard level since #472 (mirrors NEW_VAULT_ARGON2_PARAMS).
const STANDARD_PARAMS = { ops: 3, mem: 256 * 1024 * 1024 };

async function dismissAllModals(
  obsidian: Awaited<ReturnType<typeof launchUnconfigured>>,
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const count = await obsidian.win.locator(".modal-container").count();
    if (count === 0) break;
    const closeBtn = obsidian.win.locator(".modal-close-button").last();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
    } else {
      await obsidian.win.keyboard.press("Escape");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * #482: a device that joins a vault must store the KDF params it derived with
 * (the vault's stored params, or the fallback it backfilled) in settings.argon2Params.
 * Otherwise unlockVault (plugin/main.ts) derives with the device's local default and
 * the correct passphrase fails verification after a lock (#482).
 */
test("joined device stores the vault's KDF params and unlocks after lock", async () => {
  test.slow();
  const server = await startServer();
  const A = await launchUnconfigured(server, { keepStartupModal: false });
  const B = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    // Device A creates a vault via the real flow. Since #472 new vaults use Standard
    // (3 / 256 MiB) params, stored server-side and in A's settings.
    await waitForPluginLoaded(A);
    await A.eval(
      `await app.plugins.plugins.geode.createVaultFlow({ serverUrl: ${
        JSON.stringify(server.url)
      }, adminToken: "e2e", vaultName: "vault", deviceName: "e2e-device", passphrase: ${
        JSON.stringify(PASSPHRASE)
      } })`,
    );
    await waitForUnlocked(A);
    const aVaultId = await A.eval<string>("app.plugins.plugins.geode.settings.vaultId");

    // Confirm the server advertises the Standard params for this vault.
    const info = await (await fetch(`${server.url}/vaults/${aVaultId}/info`, {
      headers: { Authorization: "Bearer e2e" },
    })).json() as { argon2_ops: number | null; argon2_mem: number | null };
    expect({ ops: info.argon2_ops, mem: info.argon2_mem }).toEqual(STANDARD_PARAMS);

    // Device B joins via the real wizard (overlay-proof eval; see gate7 spec).
    await waitForPluginLoaded(B);
    await focusSetupWizard(B);
    await B.eval(
      `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
    );
    await B.win.locator('[data-testid="geode-join-server"]').waitFor();

    await B.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);
    await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

    await B.eval(`
      const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
      sel.value = ${JSON.stringify(aVaultId)};
      sel.dispatchEvent(new Event('change'));
      document.querySelector('[data-testid="geode-join-device-name"]').value = "device-B";
      document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
      JSON.stringify(PASSPHRASE)
    };
      document.querySelector('[data-testid="geode-join-submit"]').click();
      return true;
    `);

    await waitForUnlocked(B);

    // #482 regression: the joined device stores the params it derived with: the
    // vault's Standard params, not its local default (ops=1/mem=8192 in tests).
    expect(
      await B.eval<{ ops: number; mem: number }>(
        "app.plugins.plugins.geode.settings.argon2Params",
      ),
    ).toEqual(STANDARD_PARAMS);

    // Lock via the real command, then unlock via the real passphrase modal. The
    // correct passphrase must verify: unlockVault derives with settings.argon2Params.
    await B.eval<void>(`app.commands.executeCommandById("geode:geode-lock")`);
    await waitForStatusBar(B.win, "Geode: locked", 30_000);

    await dismissAllModals(B);
    await B.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);
    const modal = B.win.locator('.modal:has([data-testid="geode-passphrase-input"])');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await modal.locator('[data-testid="geode-passphrase-submit"]').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });

    // The unlock went through the real unlockVault path (derive + checkVerifier).
    expect(await B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()")).toBe(true);
    const statusText = await waitForStatusBar(B.win, "Geode: synced", 60_000);
    expect(statusText).toMatch(/^Geode: synced/);
  } finally {
    await A.close();
    await B.close();
    await server.stop();
  }
});
