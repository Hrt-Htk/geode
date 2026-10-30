import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { focusSetupWizard, waitForUnlocked } from "../helpers/geode";
import {
  relaunchDesktop,
  serverDeviceCount,
  unlockIfLocked,
  waitForServerState,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow b (desktop): EXPECTED: the app is SIGKILLed mid leave, once the server-side
// revoke has landed but the local settings/state files are not yet cleared (the only possible
// mixed state); a relaunch is honest: the status bar shows "Geode: offline" (the device is
// revoked server-side), never "synced" and never silent, and finishing the leave from
// settings completes it: unconfigured state, settings cleared, state files gone. Fully left,
// not a mix.
const PASSPHRASE = "interrupt-leave-pass";

test("issue493: kill mid leave → relaunch → honest offline state, finishing the leave → fully unconfigured", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("interrupt-leave");

  const a = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
    keepUserDataDir: true,
  });

  try {
    await waitForUnlocked(a);
    await waitForStatusBar(a.win, "Geode: synced", 60_000);

    /* Start the leave from the real settings UI. */
    await a.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await a.win.locator(".geode-advanced-heading").click();
    await a.win.locator('[data-testid="geode-settings-leave"]').click();
    await expect(a.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await a.win.locator('[data-testid="geode-confirm-yes"]').click();

    /* Deterministic mid-leave signal: the server soft-revoke has landed. The kill lands
       somewhere in revoke → delete-state-files → clear-settings; the relaunch is therefore
       either the mixed state (configured, pointing at a now-revoked device) or already-left
       (unconfigured): both honest. */
    await waitForServerState(
      () => serverDeviceCount(server.dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "device revoked on the server",
    );

    const a2 = await relaunchDesktop(a);
    try {
      const configured = await a2.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
      if (configured !== "") {
        /* Mixed state: settings point at a now-revoked device. Honest = "Geode: offline"
           (the token is dead server-side), never "synced" and never silent. */
        await unlockIfLocked(a2, PASSPHRASE);
        await waitForStatusBar(a2.win, "Geode: offline", 30_000);
        await a2.win.screenshot({
          path: shotPath("493-leave-relaunch-offline.png"),
          fullPage: true,
        });

        /* Finishing the leave works: settings → Advanced → Leave → confirm. */
        await a2.eval(`
          if (app.setting && typeof app.setting.close === "function") app.setting.close();
          app.setting.open();
          app.setting.openTabById("geode");
          return true;
        `);
        await a2.win.locator(".geode-advanced-heading").click();
        await a2.win.locator('[data-testid="geode-settings-leave"]').click();
        await expect(a2.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
        await a2.win.locator('[data-testid="geode-confirm-yes"]').click();
        await expect(a2.win.locator('[data-testid="geode-settings-run-wizard"]')).toBeVisible({
          timeout: 15_000,
        });
      } else {
        /* The leave completed before the kill: the wizard re-opens (honest, not a
           half-configured plugin). */
        await focusSetupWizard(a2);
        await a2.win.screenshot({
          path: shotPath("493-leave-relaunch-wizard.png"),
          fullPage: true,
        });
      }

      /* Fully left in both cases: settings cleared, state files gone. */
      expect(await a2.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId")).toBe("");
      const stateFileGone = await a2.eval<boolean>(
        `!(await app.vault.adapter.exists(
          app.plugins.plugins.geode.pluginDataPath("local-files.json")))`,
      );
      expect(stateFileGone, "local-files.json must be gone after the finished leave").toBe(true);
      await a2.win.screenshot({ path: shotPath("493-leave-finished.png"), fullPage: true });
    } finally {
      await a2.close();
    }
  } finally {
    await a.close();
    await rm(a.vaultDir, { recursive: true, force: true });
    await rm(a.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});
