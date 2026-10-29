import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";

const PASSPHRASE = "key-cache-storage-pass";
// #534: the cache now lives in Obsidian's per-device, vault-scoped local storage.
const STORAGE_KEY = "key-cache";

async function cachedInStore(obsidian: Awaited<ReturnType<typeof connectPhone>>) {
  return await obsidian.eval<boolean>(
    `app.loadLocalStorage(${JSON.stringify(STORAGE_KEY)}) !== null`,
  );
}

// The legacy in-vault cache file must never exist (mobile adapter, Capacitor FS).
async function legacyCacheExists(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
): Promise<boolean> {
  return await obsidian.eval<boolean>(`
    (() => {
      const geode = app.plugins.plugins.geode;
      const dir = geode?.manifest?.dir ?? (app.vault.configDir + "/plugins/geode");
      return app.vault.adapter.exists(dir + "/.geode_key_cache.json");
    })()
  `);
}

test("key cache lives in per-device storage, never in the vault (mobile)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("key-cache-storage-phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
  });

  try {
    /* connectPhone starts locked: unlock via the real unlockVault path. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Cache must be in per-device local storage, and NOT in the vault folder. */
    expect(await cachedInStore(obsidian), "cache in local storage after unlock").toBe(true);
    expect(await legacyCacheExists(obsidian), "no in-vault cache after unlock").toBe(false);

    /* ---- Lock vault via the real command (Obsidian prefixes custom command ids) ---- */
    await obsidian.eval(`await app.commands.executeCommandById("geode:geode-lock"); return true;`);
    await expect.poll(() => cachedInStore(obsidian), { timeout: 15_000 }).toBe(false);
    expect(await obsidian.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()")).toBe(false);

    /* Re-unlock so the cache is rewritten, then test Leave vault. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    expect(await cachedInStore(obsidian), "cache in local storage after re-unlock").toBe(true);

    /* ---- Leave vault via the settings button (real UI seam) ---- */
    await dismissModals(obsidian);
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return "ok";
    `);
    await evalClick(obsidian, ".geode-advanced-heading");
    await expect(
      obsidian.win.locator('[data-testid="geode-settings-leave"]'),
    ).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-settings-leave"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');

    /* After leave the cache must be gone from per-device storage. */
    await expect.poll(() => cachedInStore(obsidian), { timeout: 15_000 }).toBe(false);
    expect(await legacyCacheExists(obsidian), "no in-vault cache after leave").toBe(false);

    /* No [error] log lines. */
    const errorCount = await obsidian.eval<number>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error").length`,
    );
    expect(errorCount, `expected no log errors after lock/leave, found ${errorCount}`).toBe(0);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
