import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { evalClick, evalSetValue } from "../helpers/mobile-ui";

const PASSPHRASE = "gate7-phone-wizard-pass";
const BLANK_CREDS = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };

test("gate7 phone create-vault wizard provisions, unlocks, and syncs a note to the server", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);
    await focusSetupWizard(obsidian);

    await evalClick(obsidian, '[data-testid="geode-wizard-create"]');
    await evalSetValue(obsidian, '[data-testid="geode-create-server"]', server.url);
    await evalSetValue(obsidian, '[data-testid="geode-create-admin"]', "e2e");
    await evalClick(obsidian, '[data-testid="geode-create-continue"]');
    await expect
      .poll(() =>
        obsidian.eval<boolean>(
          `!!document.querySelector('[data-testid="geode-create-vault-name"]')`,
        )
      )
      .toBe(true);
    await evalSetValue(obsidian, '[data-testid="geode-create-vault-name"]', "gate7-phone-wizard");
    await evalSetValue(obsidian, '[data-testid="geode-create-passphrase"]', PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-create-confirm"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-create-submit"]');

    await waitForUnlocked(obsidian);

    await obsidian.eval(`
      const path = "notes/created-wizard.md";
      const content = "# created\\nvia phone wizard\\n";
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
      await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
      return true;
    `);

    const creds = await obsidian.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.settings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    await expect
      .poll(async () => {
        const res = await fetch(`${server.url}/vaults/${creds.vaultId}/heads?after_seq=0`, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return 0;
        const body = (await res.text()).trim();
        return body ? body.split("\n").length : 0;
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);

    expect(await obsidian.consoleErrors()).not.toContainEqual(
      expect.stringContaining("Failed to fetch"),
    );
  } finally {
    await obsidian.close();
    await server.stop();
  }
});

test("gate7 phone createVaultFlow eval provisions, unlocks, and syncs a note to the server", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);

    await obsidian.eval(`
      await app.plugins.plugins.geode.createVaultFlow({
        serverUrl: ${JSON.stringify(server.url)},
        adminToken: "e2e",
        vaultName: "gate7-phone-flow",
        deviceName: "e2e-device",
        passphrase: ${JSON.stringify(PASSPHRASE)},
      });
      return true;
    `);

    await waitForUnlocked(obsidian);

    await obsidian.eval(`
      const path = "notes/created-flow.md";
      const content = "# created\\nvia phone flow\\n";
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
      await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
      return true;
    `);

    const creds = await obsidian.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.settings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    await expect
      .poll(async () => {
        const res = await fetch(`${server.url}/vaults/${creds.vaultId}/heads?after_seq=0`, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return 0;
        const body = (await res.text()).trim();
        return body ? body.split("\n").length : 0;
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);

    expect(await obsidian.consoleErrors()).not.toContainEqual(
      expect.stringContaining("Failed to fetch"),
    );
  } finally {
    await obsidian.close();
    await server.stop();
  }
});
