import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #424 (phone): the Advanced section shows read-only rows: Server address
// with [Edit], Vault ID / Device token / Salt with [Copy]. The Edit modal
// opens prefilled and cancels without touching the address; a revoked device
// token (#706) shows its own line in the real modal.
const PASSPHRASE = "server-address-edit-pass";
const REVOKED_COPY =
  "This device is not recognised. Rejoin the vault. Your previous address is kept.";

test("server address (phone): read-only advanced rows, modal open and cancel", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("server-address-edit");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    keepStartupModal: true,
  });

  try {
    /* Unlock via eval, then wait for a synced baseline. */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await waitForStatusBar(obsidian.win, "Geode: synced", 90_000);
    await dismissModals(obsidian);

    /* Open the settings tab and expand Advanced. */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    await evalClick(obsidian, ".geode-advanced-heading");
    await expect(obsidian.win.locator(".geode-advanced-fields:not(.geode-collapsed)")).toHaveCount(
      1,
    );

    /* Read-only rows: values present, [Edit] on the server row, [Copy] on the rest. */
    const serverValue = obsidian.win.locator('[data-testid="geode-settings-adv-server"]');
    await expect(serverValue).toBeVisible();
    expect((await serverValue.textContent())?.trim()).toBe(server.url);
    await expect(obsidian.win.locator('[data-testid="geode-settings-adv-server-edit"]'))
      .toBeVisible();
    for (const id of ["vault-id", "device-token", "salt"]) {
      await expect(obsidian.win.locator(`[data-testid="geode-settings-adv-${id}"]`)).toBeVisible();
      await expect(obsidian.win.locator(`[data-testid="geode-settings-adv-${id}-copy"]`))
        .toBeVisible();
    }
    /* No editable inputs remain for the four values. */
    for (const id of ["server", "vault-id", "device-token", "salt"]) {
      await expect(
        obsidian.win.locator(`input[data-testid="geode-settings-adv-${id}"]`),
      ).toHaveCount(0);
    }
    await obsidian.screenshot(shotPath("424-phone-01.png"));

    /* Edit → modal opens prefilled with the current address. */
    await evalClick(obsidian, '[data-testid="geode-settings-adv-server-edit"]');
    const modal = obsidian.win.locator(".modal:has(:text('Change server address'))");
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const input = obsidian.win.locator('[data-testid="geode-server-url-input"]');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe(server.url);

    /* Cancel → modal closes, the address is untouched. */
    await evalClick(obsidian, '[data-testid="geode-server-cancel"]');
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    expect(
      await obsidian.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl"),
    ).toBe(server.url);

    /* #706: a revoked device token gets its own line, not "no vault". */
    const stale = await server.mintToken("revoked-device");
    const revoke = await fetch(
      `${server.url}/vaults/${server.vaultId}/devices/${stale.deviceId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${stale.token}` } },
    );
    expect(revoke.status).toBe(200);
    await obsidian.eval(
      `app.plugins.plugins.geode.pluginSettings.deviceToken = ${JSON.stringify(stale.token)};` +
        " return true;",
    );
    await evalClick(obsidian, '[data-testid="geode-settings-adv-server-edit"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await evalSetValue(obsidian, '[data-testid="geode-server-url-input"]', server.url);
    await evalClick(obsidian, '[data-testid="geode-server-save"]');
    await expect
      .poll(
        async () => await obsidian.win.locator(".geode-error").textContent(),
        { timeout: 30_000 },
      )
      .toBe(REVOKED_COPY);
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      return true;
    `);
    await obsidian.screenshot(shotPath("706-phone-revoked-device.png"));
    await evalClick(obsidian, '[data-testid="geode-server-cancel"]');
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await obsidian.eval(
      `app.plugins.plugins.geode.pluginSettings.deviceToken = ${JSON.stringify(device.token)};` +
        " return true;",
    );
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
