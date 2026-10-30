import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { waitForConvergence } from "../helpers/waits";

const PASSPHRASE = "gate7-pair-passphrase";
const FILE_PATH = "notes/paired.md";
const CONTENT = "# paired\nfrom device A\n";

test("gate7 second device joins via admin-token wizard and converges", async () => {
  test.slow();
  const server = await startServer();
  const A = await launchUnconfigured(server, { keepStartupModal: false });
  const B = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(A);
    await A.eval(
      `await app.plugins.plugins.geode.createVaultFlow({ serverUrl: ${
        JSON.stringify(server.url)
      }, adminToken: "e2e", vaultName: "gate7-admin", deviceName: "e2e-device", passphrase: ${
        JSON.stringify(PASSPHRASE)
      } })`,
    );
    await waitForUnlocked(A);
    const aVaultId = await A.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");

    await waitForPluginLoaded(B);
    await focusSetupWizard(B);
    // Drive the join wizard via eval: the Obsidian Settings modal overlay intermittently intercepts
    // real pointer events on the wizard buttons. The submit handler reads input .value directly, so
    // setting values + clicking through the DOM is equivalent and overlay-proof.
    await B.eval(
      `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
    );
    await B.win.locator('[data-testid="geode-join-server"]').waitFor();

    // Enter server URL and admin token, then load vaults
    await B.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);

    // Wait for vaults to load
    await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

    // Select vault, set device name + passphrase, submit
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
    const bVaultId = await B.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
    expect(bVaultId).toBe(aVaultId);

    await A.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const content = ${JSON.stringify(CONTENT)};
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
      await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
      return true;
    `);

    const converged = await waitForConvergence(A, B, FILE_PATH, 60_000);
    expect(converged).toBe(CONTENT);
  } finally {
    await A.close();
    await B.close();
    await server.stop();
  }
});

test("gate7 join with a wrong passphrase is rejected", async () => {
  test.slow();
  const server = await startServer();
  const A = await launchUnconfigured(server, { keepStartupModal: false });
  const B = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(A);
    await A.eval(
      `await app.plugins.plugins.geode.createVaultFlow({ serverUrl: ${
        JSON.stringify(server.url)
      }, adminToken: "e2e", vaultName: "gate7-wrong", deviceName: "e2e-device", passphrase: ${
        JSON.stringify(PASSPHRASE)
      } })`,
    );
    await waitForUnlocked(A);
    const aVaultId = await A.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");

    await waitForPluginLoaded(B);
    await focusSetupWizard(B);
    // Drive the join wizard via eval (overlay-proof); see note in the first test.
    await B.eval(
      `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
    );
    await B.win.locator('[data-testid="geode-join-server"]').waitFor();

    // Enter server URL and admin token, then load vaults
    await B.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);

    // Wait for vaults to load
    await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

    // Select vault, set device name + WRONG passphrase, submit
    await B.eval(`
      const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
      sel.value = ${JSON.stringify(aVaultId)};
      sel.dispatchEvent(new Event('change'));
      document.querySelector('[data-testid="geode-join-device-name"]').value = "device-B";
      document.querySelector('[data-testid="geode-join-passphrase"]').value = "totally-wrong-passphrase";
      document.querySelector('[data-testid="geode-join-submit"]').click();
      return true;
    `);

    await expect(B.win.locator('[data-testid="geode-join-error"]')).not.toBeEmpty({
      timeout: 30_000,
    });
    expect(await B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()")).toBe(false);
  } finally {
    await A.close();
    await B.close();
    await server.stop();
  }
});
