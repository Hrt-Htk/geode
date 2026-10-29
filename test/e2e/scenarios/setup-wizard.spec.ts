import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";

/**
 * #459: the redesigned setup wizard (#441, #459).
 *
 * One step per screen, Back on form steps, Enter submits, a working label on the
 * CTA, inline errors, encryption strength on create, a Done screen. Asserts the
 * chosen (non-default) level's argon2 params landed in settings AND on the server.
 */

const SHOT = (name: string): string => shotPath(name);
const modalShot = (win: Awaited<ReturnType<typeof launchUnconfigured>>["win"], name: string) =>
  win.locator(".modal-container").first().screenshot({ path: SHOT(name) });

const PASSPHRASE = "create-passphrase";
const WRONG_PASSPHRASE = "wrong-passphrase";
const HIGHER = { ops: 4, mem: 512 * 1024 * 1024 };
// #530: the placeholder advertises the server's default port, not the dead 2705.
const SERVER_PLACEHOLDER = "localhost:8080 or geode.example.com";

test("create: inline errors, Enter, Back, Higher params stored server-side", async () => {
  test.slow();
  const server = await startServer();
  const obs = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(obs);
    await focusSetupWizard(obs);
    const win = obs.win;

    await modalShot(win, "459-wizard-choose.png");
    await win.locator('[data-testid="geode-wizard-create"]').click();
    await win.locator('[data-testid="geode-create-server"]').waitFor();

    // #530: server-address placeholder shows the default port 8080 (one line, no dashes).
    expect(await win.locator('[data-testid="geode-create-server"]').getAttribute("placeholder"))
      .toBe(
        SERVER_PLACEHOLDER,
      );
    await modalShot(win, "459-wizard-create-server.png");

    // can't reach server
    await win.locator('[data-testid="geode-create-server"]').fill("http://127.0.0.1:1");
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await expect(win.locator('[data-testid="geode-create-error"]')).toContainText(
      "Couldn't reach the server at 127.0.0.1:1.",
    );
    await modalShot(win, "459-wizard-create1-unreachable.png");

    // admin token not valid
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-admin"]').fill("wrong-token");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await expect(win.locator('[data-testid="geode-create-error"]')).toHaveText(
      "That admin token isn't valid.",
    );

    // empty server + admin
    await win.locator('[data-testid="geode-create-server"]').fill("");
    await win.locator('[data-testid="geode-create-admin"]').fill("");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await expect(win.locator('[data-testid="geode-create-error"]')).toHaveText(
      "Enter a server address and admin token.",
    );

    // Enter submits the CTA
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-server"]').press("Enter");
    await win.locator('[data-testid="geode-create-vault-name"]').waitFor();

    // Back returns to the server step, values kept
    await win.locator('[data-testid="geode-wizard-back"]').click();
    await win.locator('[data-testid="geode-create-server"]').waitFor();
    expect(await win.locator('[data-testid="geode-create-server"]').inputValue()).toBe(server.url);
    expect(await win.locator('[data-testid="geode-create-admin"]').inputValue()).toBe("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await win.locator('[data-testid="geode-create-vault-name"]').waitFor();

    // passphrase too short
    await win.locator('[data-testid="geode-create-vault-name"]').fill("vault");
    await win.locator('[data-testid="geode-create-passphrase"]').fill("short");
    await win.locator('[data-testid="geode-create-confirm"]').fill("short");
    await win.locator('[data-testid="geode-create-submit"]').click();
    await expect(win.locator('[data-testid="geode-create-error"]')).toHaveText(
      "Passphrase is too short.",
    );

    // passphrases don't match
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE + "X");
    await win.locator('[data-testid="geode-create-submit"]').click();
    await expect(win.locator('[data-testid="geode-create-error"]')).toHaveText(
      "Passphrases don't match.",
    );

    // clean state + Higher for the screenshot, then complete the create
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE);
    await obs.eval(`
      const sel = document.querySelector('[data-testid="geode-create-strength"]');
      sel.value = "higher";
      sel.dispatchEvent(new Event("change"));
      document.querySelector('[data-testid="geode-create-error"]').textContent = "";
      return true;
    `);
    await modalShot(win, "459-wizard-create2-higher.png");
    await win.locator('[data-testid="geode-create-submit"]').click();

    await waitForUnlocked(obs);

    const creds = await obs.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.settings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    // #459: the chosen level's params flow into settings and are stored on the server.
    expect(await obs.eval(`app.plugins.plugins.geode.settings.argon2Params`)).toEqual(HIGHER);
    const info = await (await fetch(`${server.url}/vaults/${creds.vaultId}/info`, {
      headers: { Authorization: "Bearer e2e" },
    })).json() as { argon2_ops: number; argon2_mem: number };
    expect({ ops: info.argon2_ops, mem: info.argon2_mem }).toEqual(HIGHER);

    // Done screen closes the wizard.
    await expect(win.locator('[data-testid="geode-done-submit"]')).toBeVisible();
    await modalShot(win, "459-wizard-done.png");
    await win.locator('[data-testid="geode-done-submit"]').click();
    await expect(win.locator('[data-testid="geode-done-submit"]')).toHaveCount(0);
  } finally {
    await obs.close();
    await server.stop();
  }
});

test("join: wrong passphrase shows the inline error, correct passphrase joins", async () => {
  test.slow();
  const server = await startServer();

  // Device A creates a vault (stores the verifier + params server-side), then closes.
  const A = await launchUnconfigured(server, { keepStartupModal: true });
  let vaultId = "";
  try {
    await waitForPluginLoaded(A);
    await focusSetupWizard(A);
    const win = A.win;
    await win.locator('[data-testid="geode-wizard-create"]').click();
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await win.locator('[data-testid="geode-create-vault-name"]').fill("join-vault");
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-submit"]').click();
    await waitForUnlocked(A);
    vaultId = await A.eval<string>(`app.plugins.plugins.geode.settings.vaultId`);
    await win.locator('[data-testid="geode-done-submit"]').click();
  } finally {
    await A.close();
  }

  // Device B joins the same vault: wrong passphrase first, then the correct one.
  const B = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(B);
    await focusSetupWizard(B);
    const win = B.win;
    await win.locator('[data-testid="geode-wizard-join"]').click();
    await win.locator('[data-testid="geode-join-server"]').waitFor();
    expect(await win.locator('[data-testid="geode-join-server"]').getAttribute("placeholder")).toBe(
      SERVER_PLACEHOLDER,
    );
    await win.locator('[data-testid="geode-join-server"]').fill(server.url);
    await win.locator('[data-testid="geode-join-admin"]').fill("e2e");
    await modalShot(win, "459-wizard-join1.png");
    await win.locator('[data-testid="geode-join-load"]').click();
    await win.locator('[data-testid="geode-join-vault-select"]').waitFor();
    await modalShot(win, "459-wizard-join2.png");

    await B.eval(`
      const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
      sel.value = ${JSON.stringify(vaultId)};
      sel.dispatchEvent(new Event("change"));
      return true;
    `);
    await win.locator('[data-testid="geode-join-device-name"]').fill("join-device");
    await win.locator('[data-testid="geode-join-passphrase"]').fill(WRONG_PASSPHRASE);
    await win.locator('[data-testid="geode-join-submit"]').click();
    await expect(win.locator('[data-testid="geode-join-error"]')).toHaveText(
      "That passphrase doesn't match this vault.",
    );

    await win.locator('[data-testid="geode-join-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-join-submit"]').click();
    await waitForUnlocked(B);
    expect(await B.eval<string>(`app.plugins.plugins.geode.settings.vaultId`)).toBe(vaultId);
    await win.locator('[data-testid="geode-done-submit"]').click();
  } finally {
    await B.close();
    await server.stop();
  }
});
