import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import { focusSetupWizard, waitForUnlocked } from "../helpers/geode";
import { serverDeviceCount, unlockIfLocked, waitForServerState } from "../helpers/interrupt";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #493 flow b (phone): EXPECTED: the phone is force-stopped mid leave, once the server-side
// revoke has landed but the local settings/state files are not yet cleared (the only possible
// mixed state); a relaunch is honest: the status bar shows "Geode: offline" (the device is
// revoked server-side), never "synced" and never silent, and finishing the leave from
// settings completes it: unconfigured state, settings cleared, state files gone. Fully left,
// not a mix.
const PASSPHRASE = "interrupt-leave-phone-pass";

test("issue493 (phone): force-stop mid leave → relaunch → honest offline state, finishing the leave → fully unconfigured", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-leave-phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);
    await dismissModals(obsidian);

    /* Start the leave from the real settings UI (no leading app.setting.close() on mobile). */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await evalClick(obsidian, ".geode-advanced-heading");
    await evalClick(obsidian, '[data-testid="geode-settings-leave"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');

    /* Deterministic mid-leave signal: the server soft-revoke has landed. The kill lands
       somewhere in revoke → delete-state-files → clear-settings; the relaunch is therefore
       either the mixed state (configured, pointing at a now-revoked device) or already-left
       (unconfigured): both honest. */
    await waitForServerState(
      () => serverDeviceCount(dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "device revoked on the server",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      const configured = await obsidian2.eval<string>(
        "app.plugins.plugins.geode.pluginSettings.vaultId",
      );
      if (configured !== "") {
        /* Mixed state: settings point at a now-revoked device. Honest = offline, not synced. */
        await unlockIfLocked(obsidian2, PASSPHRASE);
        await waitForStatusBar(obsidian2.win, "Geode: offline", 30_000);
        await obsidian2.screenshot(shotPath("493-leave-phone-relaunch-offline.png"));

        /* Finishing the leave works: settings → Advanced → Leave → confirm. */
        await obsidian2.eval(`
          app.setting.open();
          app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
          return true;
        `);
        await evalClick(obsidian2, ".geode-advanced-heading");
        await evalClick(obsidian2, '[data-testid="geode-settings-leave"]');
        await expect(obsidian2.win.locator(".geode-confirm-modal")).toBeVisible({
          timeout: 10_000,
        });
        await evalClick(obsidian2, '[data-testid="geode-confirm-yes"]');
        await obsidian2.win.waitForFunction(
          () => !!document.querySelector('[data-testid="geode-settings-run-wizard"]'),
          undefined,
          { timeout: 15_000 },
        );
      } else {
        /* The leave completed before the kill: the wizard re-opens (honest). */
        await focusSetupWizard(obsidian2);
        await obsidian2.screenshot(shotPath("493-leave-phone-relaunch-wizard.png"));
      }

      /* Fully left in both cases: settings cleared, state files gone. */
      expect(await obsidian2.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId")).toBe(
        "",
      );
      const stateFileGone = await obsidian2.eval<boolean>(
        `!(await app.vault.adapter.exists(
          app.plugins.plugins.geode.pluginDataPath("local-files.json")))`,
      );
      expect(stateFileGone, "local-files.json must be gone after the finished leave").toBe(true);
      await obsidian2.screenshot(shotPath("493-leave-phone-finished.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
