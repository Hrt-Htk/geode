import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #459: on-device: the redesigned create wizard, step by step.

const PASSPHRASE = "phone-create-pass";
const BLANK_CREDS = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };
const SHOT = (name: string): string => shotPath(name);
const STANDARD = { ops: 3, mem: 256 * 1024 * 1024 };

test("phone create wizard walks the redesigned steps and screenshots each", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);
    await focusSetupWizard(obsidian);
    await obsidian.screenshot(SHOT("phone-459-wizard-choose.png"));

    await evalClick(obsidian, '[data-testid="geode-wizard-create"]');
    await expect
      .poll(() =>
        obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-create-server"]')`)
      )
      .toBe(true);
    await obsidian.screenshot(SHOT("phone-459-wizard-create1.png"));

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
    await obsidian.screenshot(SHOT("phone-459-wizard-create2.png"));

    await evalSetValue(obsidian, '[data-testid="geode-create-vault-name"]', "phone-vault");
    await evalSetValue(obsidian, '[data-testid="geode-create-passphrase"]', PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-create-confirm"]', PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-create-submit"]');

    await waitForUnlocked(obsidian);
    await obsidian.screenshot(SHOT("phone-459-wizard-done.png"));

    const creds = await obsidian.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.settings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    // Default level on the phone walk is Standard, stored on device and server (#457).
    expect(await obsidian.eval(`app.plugins.plugins.geode.settings.argon2Params`)).toEqual(
      STANDARD,
    );
    const info = await (await fetch(`${server.url}/vaults/${creds.vaultId}/info`, {
      headers: { Authorization: "Bearer e2e" },
    })).json() as { argon2_ops: number; argon2_mem: number };
    expect({ ops: info.argon2_ops, mem: info.argon2_mem }).toEqual(STANDARD);

    await evalClick(obsidian, '[data-testid="geode-done-submit"]');
    await expect
      .poll(() =>
        obsidian.eval<boolean>(`!document.querySelector('[data-testid="geode-done-submit"]')`)
      )
      .toBe(true);
  } finally {
    await obsidian.close();
    await server.stop();
  }
});
