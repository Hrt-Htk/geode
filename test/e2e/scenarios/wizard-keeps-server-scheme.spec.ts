// #35: the wizard keeps the scheme the user typed. The test server speaks plain
// http, so https on the same host and port can only fail: the wizard must stay on
// the server step with the error. A scheme dropped on the way (the bug) dials http
// instead, connects, and moves on to the vault step.
import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "wizard-scheme-pass";

test("wizard keeps the typed scheme: https to a plain http server fails, http proceeds", async () => {
  test.slow();
  const server = await startServer();
  const host = new URL(server.url).host;
  const obs = await launchUnconfigured(server, { keepStartupModal: true });
  try {
    await waitForPluginLoaded(obs);
    await focusSetupWizard(obs);
    const win = obs.win;

    await win.locator('[data-testid="geode-wizard-create"]').click();
    await win.locator('[data-testid="geode-create-server"]').fill(`https://${host}`);
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();

    // Settle either way (error on the server step, or the vault step) so the shot
    // shows the same point on both sides of the fix.
    const outcome = (): Promise<string> =>
      obs.eval<string>(`(() => {
        const error = document.querySelector('[data-testid="geode-create-error"]');
        if (error && error.textContent.trim()) return error.textContent.trim();
        if (document.querySelector('[data-testid="geode-create-vault-name"]')) return "vault step";
        return "";
      })()`);
    await expect.poll(outcome, { timeout: 60_000 }).not.toBe("");
    await win.locator(".modal-container").first().screenshot({
      path: shotPath("35-01-https-refused.png"),
    });

    await expect(win.locator('[data-testid="geode-create-error"]')).toHaveText(
      `Couldn't reach the server at https://${host}.`,
    );
    await expect(win.locator('[data-testid="geode-create-vault-name"]')).toHaveCount(0);

    // The same host and port without tls connects, and the saved address keeps the
    // scheme the user typed.
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-continue"]').click();
    await win.locator('[data-testid="geode-create-vault-name"]').waitFor();
    await win.locator('[data-testid="geode-create-vault-name"]').fill("wizard-scheme-vault");
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-submit"]').click();
    await waitForUnlocked(obs);

    expect(
      await obs.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl"),
    ).toBe(server.url);
  } finally {
    await obs.close();
    await server.stop();
  }
});
