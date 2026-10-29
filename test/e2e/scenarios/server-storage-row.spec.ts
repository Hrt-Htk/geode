import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #341/#553: the settings Status section shows this vault's size first, then
// the server's free space: "This vault X · Y free" with a two-segment meter
// (vault in accent, other used space muted) from GET /vaults/:id/storage
// (device-token auth, statvfs + vault blob walk). When the server is
// unreachable the row flips to "Storage info unavailable. The server didn't
// answer." with the meter hidden: both updates happen in place; the tab is
// never re-rendered.
const PASSPHRASE = "server-storage-row-pass";

const STORAGE_ROW = '[data-testid="geode-settings-storage"]';
const METER = `${STORAGE_ROW} .geode-storage-meter`;
// Server-answered states: the real usage line ("This vault X · Y free") or the
// low-space warning ("Low on server space. X free."): both one-line, both with
// a visible meter. Which one shows depends on the machine's actual free space:
// the E2E server's data dir lives on /tmp tmpfs, which on this machine has
// < 5 GB free, so the row naturally renders the warning, not the normal line.
const SERVER_ANSWERED =
  /^(This vault [\d.]+ (KB|MB|GB|TB) · [\d.]+ (KB|MB|GB|TB) free|This vault [\d.]+ (KB|MB|GB|TB) · Low on server space\. [\d.]+ (KB|MB|GB|TB) free\.)$/;
const UNAVAILABLE_TEXT = "Storage info unavailable. The server didn't answer.";

test("server storage: used/free row + meter, unavailable on dead server, no re-render", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("server-storage-row");
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

    /* Open the settings tab on the Geode tab and keep it open. */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const row = o.win.locator(STORAGE_ROW);
    await row.waitFor({ timeout: 15_000 });

    /* ---- 1. Normal: "This vault X · Y free" with a visible meter ---- */
    await expect.poll(
      async () => await row.locator(".setting-item-description").textContent(),
      { timeout: 30_000 },
    ).toMatch(SERVER_ANSWERED);
    await expect(o.win.locator(METER)).toBeVisible();
    await expect(o.win.locator(METER)).not.toHaveClass(/geode-storage-meter-hidden/);

    /* Marker on the Status section: a full re-render would recreate it. */
    await o.eval(`
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const st = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Status"));
      if (!st) throw new Error("Status section not found");
      st.dataset.e2eMarker = "no-rerender";
      return true;
    `);
    const markerPresent = (): Promise<boolean> =>
      o.eval<boolean>(`!!document.querySelector('.geode-section[data-e2e-marker="no-rerender"]')`);

    /* Screenshot 1: the real server-answered state (normal line or warning,
       machine-dependent; on this machine /tmp has < 5 GB free → warning). */
    const answeredText = (await row.locator(".setting-item-description").textContent()) ?? "";
    const warned = answeredText.includes("Low on server space");
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("341-01-normal.png"),
    });
    if (warned) {
      // The low-space warning is real (not injected): capture it under its own name too.
      await o.win.locator(".vertical-tab-content").screenshot({
        path: shotPath("341-03-warning.png"),
      });
    }

    /* ---- 2. Server down: lock/unlock re-fetches in place → unavailable ---- */
    await server.shutdown();
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-lock"]').click(); return true;`,
    );
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-unlock"]').click(); return true;`,
    );
    const passModal = o.win.locator('.modal:has(:text("Unlock Geode"))');
    await expect(passModal).toBeVisible({ timeout: 10_000 });
    await passModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await passModal.locator('[data-testid="geode-passphrase-input"]').press("Enter");
    await expect(passModal).not.toBeVisible({ timeout: 15_000 });

    await expect.poll(
      async () => await row.locator(".setting-item-description").textContent(),
      { timeout: 30_000 },
    ).toBe(UNAVAILABLE_TEXT);
    await expect(o.win.locator(METER)).toHaveClass(/geode-storage-meter-hidden/);
    await expect(o.win.locator(METER)).not.toBeVisible();

    /* The tab was not re-rendered by the lock/unlock + storage refresh. */
    expect(await markerPresent(), "Status section marker must survive the storage update").toBe(
      true,
    );

    /* Screenshot 2: unavailable state. */
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("341-02-unavailable.png"),
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
