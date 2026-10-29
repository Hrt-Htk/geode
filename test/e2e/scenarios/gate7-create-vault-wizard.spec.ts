import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";

const PASSPHRASE = "gate7-create-passphrase";
const FILE_PATH = "notes/created.md";
const CONTENT = "# created\nvia wizard\n";

test("gate7 create-vault wizard provisions, unlocks, and syncs a note to the server", async () => {
  test.slow();
  const server = await startServer();
  const obs = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(obs);
    await focusSetupWizard(obs);
    const win = obs.win;
    await win.locator('[data-testid="geode-wizard-create"]').click();
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await win.locator('[data-testid="geode-create-vault-name"]').fill("gate7-vault");
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-submit"]').click();

    await waitForUnlocked(obs);
    await win.locator('[data-testid="geode-done-submit"]').click();

    await obs.eval(`
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

    const creds = await obs.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.settings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    // #457: a new vault derives at the Standard level, stored on the device and the server.
    const STANDARD = { ops: 3, mem: 256 * 1024 * 1024 };
    expect(await obs.eval(`app.plugins.plugins.geode.settings.argon2Params`)).toEqual(STANDARD);
    const info = await (await fetch(`${server.url}/vaults/${creds.vaultId}/info`, {
      headers: { Authorization: "Bearer e2e" },
    })).json() as { argon2_ops: number; argon2_mem: number };
    expect({ ops: info.argon2_ops, mem: info.argon2_mem }).toEqual(STANDARD);

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

    expect(obs.consoleErrors().filter((e) => e.includes("Failed to fetch"))).toEqual([]);
  } finally {
    await obs.close();
    await server.stop();
  }
});
