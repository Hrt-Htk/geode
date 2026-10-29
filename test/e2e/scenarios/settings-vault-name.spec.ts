import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";

/**
 * #65: the settings tab shows the vault's name (issue #65 / #336).
 *
 * Drives a REAL fresh join through the wizard, then verifies `settings.vaultName` is
 * populated from the server. As of #336 the name is NOT threaded through the join flow;
 * it is backfilled from the `server_hello_ack` handshake (vault_name) once the transport
 * connects post-unlock, so the settings value arrives asynchronously and must be polled.
 * The fixture vault has no verifier, so the join takes the no-verifier path (generates one)
 * and unlocks. Then opens the settings tab and asserts the "Vault" row shows the server's
 * vault name ("e2e-vault"), and screenshots it.
 */

const PASSPHRASE = "settings-vault-name-pass";

test("settings tab shows the vault name after a fresh join", async () => {
  test.slow();
  const server = await startServer();
  try {
    const B = await launchUnconfigured(server, { keepStartupModal: true });
    try {
      await waitForPluginLoaded(B);

      // Drive the join wizard (real path).
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
        sel.value = ${JSON.stringify(server.vaultId)};
        sel.dispatchEvent(new Event('change'));
        document.querySelector('[data-testid="geode-join-device-name"]').value = "fresh-device";
        document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
        JSON.stringify(PASSPHRASE)
      };
        document.querySelector('[data-testid="geode-join-submit"]').click();
        return true;
      `);

      await waitForUnlocked(B);

      // vaultName is backfilled from the server_hello_ack handshake after the transport
      // connects post-unlock, so poll rather than reading once (would race the ack).
      await expect.poll(
        async () => await B.eval<string>("app.plugins.plugins.geode.settings.vaultName"),
        { timeout: 10_000 },
      ).toBe("e2e-vault");

      // Open the settings tab and assert the "Geode vault" row shows "<name> · <server host>".
      await B.eval(`
        if (app.setting && typeof app.setting.close === "function") app.setting.close();
        app.setting.open();
        app.setting.openTabById("geode");
        return "ok";
      `);

      const vaultRow = B.win.locator('[data-testid="geode-settings-vault-name"]');
      await expect.poll(
        async () => await vaultRow.locator(".setting-item-description").textContent(),
        { timeout: 10_000 },
      ).toMatch(/^e2e-vault · 127\.0\.0\.1:\d+$/);

      // Clear transient notices, then screenshot the settings pane (durable UI gate).
      await B.eval(`document.querySelectorAll('.notice').forEach(n => n.remove()); return true;`);
      await B.win.locator(".vertical-tab-content").screenshot({
        path: shotPath("settings-vault-name.png"),
      })
        .catch(async () => {
          await B.win.screenshot({ path: shotPath("settings-vault-name.png") });
        });
    } finally {
      await B.close();
    }
  } finally {
    await server.stop();
  }
});
