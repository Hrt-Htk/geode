import { expect, test } from "@playwright/test";
import { useRemoteServer } from "../fixtures/phone-server";
import { connectPhone } from "../fixtures/phone-obsidian";
import { waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";

// Regression for issue #47: after the setup flow completes, an already-open Settings tab
// must re-render to the configured state, and the startup setup-wizard must be dismissed
// (previously the tab stayed on "Run setup wizard"/"Locked" and the wizard lingered).
test("settings tab refreshes to configured state after create", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.slow();
  const server = await useRemoteServer();
  // keepStartupModal: true → startup setup wizard is open, reproducing the reported scenario.
  // connectPhone({}) with no geodeSettings is the "unconfigured" analogue.
  const A = await connectPhone({});
  try {
    await waitForPluginLoaded(A);
    // connectPhone({}) keeps the persistent phone vault's previous Geode settings; leave the
    // vault so the tab really starts unconfigured (desktop gets a fresh vault per test).
    await A.eval(`
      const geode = app.plugins.plugins.geode;
      if (geode.settings.vaultId) await geode.leaveVault();
      return true;
    `);

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
          document.querySelectorAll('.geode-section .setting-item-heading'),
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
    // Modal.close() plays a close animation on Obsidian mobile 1.13.4, so the DOM node
    // lingers briefly after createVaultFlow: poll rather than read once.
    await expect.poll(
      async () =>
        await A.eval<boolean>(
          `!!document.querySelector('[data-testid="geode-wizard-create"]')`,
        ),
      { timeout: 10_000 },
    ).toBe(false);
  } finally {
    await A.close();
    await server.stop();
  }
});
