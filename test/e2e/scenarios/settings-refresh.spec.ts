import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";

// Regression for issue #47: after the setup flow completes, an already-open Settings tab
// must re-render to the configured state, and the startup setup-wizard must be dismissed
// (previously the tab stayed on "Run setup wizard"/"Locked" and the wizard lingered).
test("settings tab refreshes to configured state after create", async () => {
  test.slow();
  const server = await startServer();
  // keepStartupModal: true → startup setup wizard is open, reproducing the reported scenario.
  const A = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(A);

    // Open the Geode settings tab while unconfigured (startup wizard is underneath).
    // Unconfigured, the tab renders only the Status section (status + Set up rows): the
    // Vault section (geode-settings-vault-status) does not exist until the flow completes.
    await A.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await A.win.locator('[data-testid="geode-settings-run-wizard"]').waitFor();

    // Complete the flow the wizard would run.
    await A.eval(
      `await app.plugins.plugins.geode.createVaultFlow({ serverUrl: ${
        JSON.stringify(server.url)
      }, adminToken: "e2e", vaultName: "refresh-demo", deviceName: "e2e-device", passphrase: "pw-refresh" })`,
    );
    await waitForUnlocked(A);

    // The tab must re-render to configured state without a manual reopen: the Vault section
    // and its lock row only exist once configured, so their appearance is the refresh signal.
    await A.win.locator('[data-testid="geode-settings-vault-status"]').waitFor({ timeout: 15_000 });

    // Settings tab must now show the configured state without any manual reopen.
    const statusDesc = await A.eval<string>(
      `document.querySelector('[data-testid="geode-settings-vault-status"] .setting-item-description')?.textContent ?? ""`,
    );
    expect(statusDesc).toContain("Unlocked. Locking requires the passphrase to sync again.");
    const lockPresent = await A.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-settings-lock"]')`,
    );
    expect(lockPresent).toBe(true);

    // The configured tab also renders the collapsible sections + live sync-status row.
    const sectionsRendered = await A.eval<boolean>(`
      (() => {
        const headings = Array.from(
          document.querySelectorAll('.vertical-tab-content .geode-section .setting-item-heading'),
        ).map((h) => h.textContent ?? "");
        const order = ["Status", "Vault", "Devices", "Sync scope", "Trash", "Advanced"];
        return order.every((s, i) => headings[i]?.includes(s));
      })()
    `);
    expect(sectionsRendered).toBe(true);
    expect(
      await A.eval<boolean>(
        `!!document.querySelector('[data-testid="geode-settings-sync-status"]')`,
      ),
    ).toBe(true);

    // The startup setup wizard must be gone (no lingering "Set up Geode" choose screen).
    const wizardStillOpen = await A.eval<boolean>(
      `!!document.querySelector('[data-testid="geode-wizard-create"]')`,
    );
    expect(wizardStillOpen).toBe(false);
  } finally {
    await A.close();
    await server.stop();
  }
});
