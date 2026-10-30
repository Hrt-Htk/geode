import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #424: the server address is read-only with an [Edit] modal that checks the
// server (reachable AND vault exists for this device token) before committing;
// a failed check keeps the old address; a passed check applies live (the
// transport reconnects to the new URL without a plugin reload) and the tab is
// never re-rendered. A revoked device token (#706) gets its own copy, not
// "no vault".
const PASSPHRASE = "server-address-edit-pass";

const ADV_SERVER = '[data-testid="geode-settings-adv-server"]';
const ADV_SERVER_EDIT = '[data-testid="geode-settings-adv-server-edit"]';
const URL_INPUT = '[data-testid="geode-server-url-input"]';
const SAVE_BTN = '[data-testid="geode-server-save"]';
const STATUS_ROW = '[data-testid="geode-settings-sync-status"]';
// #706: a revoked device token must not read as a wrong address.
const REVOKED_COPY =
  "This device is not recognised. Rejoin the vault. Your previous address is kept.";

async function countHeads(server: E2EServer, token: string): Promise<number> {
  const res = await fetch(`${server.url}/vaults/${server.vaultId}/heads?after_seq=-1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`heads: ${res.status}`);
  const text = (await res.text()).trim();
  return text ? text.split("\n").length : 0;
}

async function openAdvanced(o: ObsidianInstance): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
  const advancedFields = o.win.locator(".geode-advanced-fields");
  if ((await advancedFields.getAttribute("class"))?.includes("geode-collapsed")) {
    await o.win.locator(".geode-advanced-heading").click();
  }
  await o.win.locator(ADV_SERVER).waitFor({ timeout: 15_000 });
}

async function openModal(o: ObsidianInstance) {
  await o.win.locator(ADV_SERVER_EDIT).click();
  const modal = o.win.locator(".modal:has(:text('Change server address'))");
  await modal.waitFor({ timeout: 10_000 });
  return modal;
}

test("server address: read-only rows, check-gated Edit with live apply, no re-render", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("server-address-edit");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openAdvanced(o);

    /* ---- Read-only rows: values as code, no editable inputs ---- */
    await expect(o.win.locator(`code${ADV_SERVER}`)).toBeVisible();
    await expect(o.win.locator(`input${ADV_SERVER}`)).toHaveCount(0);
    for (const id of ["vault-id", "device-token", "salt"]) {
      await expect(o.win.locator(`code[data-testid="geode-settings-adv-${id}"]`)).toBeVisible();
      await expect(o.win.locator(`input[data-testid="geode-settings-adv-${id}"]`)).toHaveCount(0);
      await expect(o.win.locator(`[data-testid="geode-settings-adv-${id}-copy"]`)).toBeVisible();
    }
    const serverRowDesc = o.win
      .locator(`.setting-item:has(${ADV_SERVER}) .setting-item-description`);
    await expect(serverRowDesc).toHaveText("Applies to this device only.");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("424-01-advanced.png"),
    });

    /* Marker on the Advanced section: a full re-render would recreate it. */
    await o.eval(`
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const adv = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Advanced"));
      if (!adv) throw new Error("Advanced section not found");
      adv.dataset.e2eMarker = "no-rerender";
      return true;
    `);
    const markerPresent = (): Promise<boolean> =>
      o.eval<boolean>(`!!document.querySelector('.geode-section[data-e2e-marker="no-rerender"]')`);

    const oldServerUrl = await o.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl");

    /* ---- 1. Edit → unreachable host → inline error, old address kept ---- */
    let modal = await openModal(o);
    const urlInput = modal.locator(URL_INPUT);
    await expect(urlInput).toHaveValue(server.url);
    await urlInput.fill("http://127.0.0.1:1");
    await modal.locator(SAVE_BTN).click();
    const errorLine = modal.locator(".geode-error");
    await expect
      .poll(async () => await errorLine.textContent(), { timeout: 30_000 })
      .toBe("Couldn't reach http://127.0.0.1:1. Your previous address is kept.");
    await expect(modal.locator(SAVE_BTN)).toBeEnabled();
    await expect(modal).toBeVisible();
    expect(await o.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl")).toBe(
      oldServerUrl,
    );
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("424-02-modal-error.png") });
    await modal.locator("button:has-text('Cancel')").click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    /* ---- 2. Edit → a base path with no Geode API → "No Geode vault" error ---- */
    const noVaultUrl = `${server.url}/geode`;
    modal = await openModal(o);
    await modal.locator(URL_INPUT).fill(noVaultUrl);
    await modal.locator(SAVE_BTN).click();
    await expect
      .poll(async () => await modal.locator(".geode-error").textContent(), { timeout: 30_000 })
      .toBe(`No Geode vault at ${noVaultUrl}. Your previous address is kept.`);
    expect(await o.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl")).toBe(
      oldServerUrl,
    );
    await modal.locator("button:has-text('Cancel')").click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    /* ---- 3. Edit → same server via localhost → saves, live apply, no reload ---- */
    const port = new URL(server.url).port;
    const altUrl = `http://localhost:${port}`;
    modal = await openModal(o);
    await modal.locator(URL_INPUT).fill(altUrl);
    await modal.locator(SAVE_BTN).click();

    /* Notice "Reconnecting to …" and the modal closes. */
    await expect(o.win.locator(".notice", { hasText: `Reconnecting to ${altUrl}…` }))
      .toBeVisible({ timeout: 15_000 });
    await expect(modal).not.toBeVisible({ timeout: 15_000 });

    /* Row value updated in place to the resolved (scheme kept) address. */
    await expect
      .poll(async () => await o.win.locator(ADV_SERVER).textContent(), { timeout: 15_000 })
      .toBe("http://localhost:" + port);
    expect(await o.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl"))
      .toBe(`http://localhost:${port}`);

    /* The transport reconnected live: status row back to "Up to date". */
    await expect
      .poll(
        async () =>
          await o.win.locator(STATUS_ROW).locator(".setting-item-description").textContent(),
        { timeout: 60_000 },
      )
      .toMatch(/^Up to date\. Last backup /);

    /* A new note syncs to the server through the reconnected transport. */
    const headsBefore = await countHeads(server, device.token);
    await o.eval(`await app.vault.create("note.md", "live apply note"); return true;`);
    await o.eval(`await app.plugins.plugins.geode.pushNow(); return true;`);
    await expect
      .poll(async () => await countHeads(server, device.token), { timeout: 60_000 })
      .toBe(headsBefore + 1);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({ path: shotPath("424-03-saved.png") });

    /* ---- 4. Copy buttons fire the "Copied to clipboard." Notice ---- */
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator('[data-testid="geode-settings-adv-vault-id-copy"]').click();
    await expect(o.win.locator(".notice", { hasText: "Copied to clipboard." }))
      .toBeVisible({ timeout: 10_000 });

    /* ---- 5. Same server, revoked device token → "not recognised", not "no vault" ---- */
    const stale = await server.mintToken("revoked-device");
    const revoke = await fetch(
      `${server.url}/vaults/${server.vaultId}/devices/${stale.deviceId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${stale.token}` } },
    );
    expect(revoke.status).toBe(200);
    const liveToken = await o.eval<string>("app.plugins.plugins.geode.pluginSettings.deviceToken");
    const setDeviceToken = (token: string): Promise<unknown> =>
      o.eval(
        `app.plugins.plugins.geode.pluginSettings.deviceToken = ${
          JSON.stringify(token)
        }; return true;`,
      );
    await setDeviceToken(stale.token);
    modal = await openModal(o);
    await modal.locator(URL_INPUT).fill(server.url);
    await modal.locator(SAVE_BTN).click();
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await expect(modal.locator(".geode-error")).toHaveText(REVOKED_COPY);
    await modal.screenshot({ path: shotPath("424-04-modal-revoked-device.png") });
    await expect(modal.locator(SAVE_BTN)).toBeEnabled();
    await modal.locator("button:has-text('Cancel')").click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
    await setDeviceToken(liveToken);
    expect(await o.eval<string>("app.plugins.plugins.geode.pluginSettings.serverUrl")).toBe(altUrl);

    /* The tab was not re-rendered at any point. */
    expect(await markerPresent(), "Advanced section marker must survive the live apply").toBe(true);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
