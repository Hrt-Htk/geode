import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "key-cache-storage-pass";
// #534: the cache now lives in Obsidian's per-device, vault-scoped local storage.
const STORAGE_KEY = "key-cache";

type Inst = Awaited<ReturnType<typeof launchObsidian>>;

// Resolve the legacy in-vault cache path exactly as the plugin does
// (manifest.dir ?? configDir/plugins/id), resolved against the vault dir.
async function legacyCachePath(obsidian: Inst): Promise<string> {
  const relDir = await obsidian.eval<string>(
    `app.plugins.plugins.geode.manifest.dir ?? app.vault.configDir + "/plugins/" + app.plugins.plugins.geode.manifest.id`,
  );
  return path.join(obsidian.vaultDir, relDir, ".geode_key_cache.json");
}

async function cachedInStore(obsidian: Inst): Promise<boolean> {
  return await obsidian.eval<boolean>(
    `app.loadLocalStorage(${JSON.stringify(STORAGE_KEY)}) !== null`,
  );
}

test("key cache lives in per-device storage, never in the vault folder", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("key-cache-storage");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
    keepUserDataDir: true,
  });

  try {
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* The cache must be in per-device local storage, and NOT in the vault folder. */
    expect(await cachedInStore(obsidian), "cache in local storage after unlock").toBe(true);
    expect(existsSync(await legacyCachePath(obsidian)), "no in-vault cache after unlock").toBe(
      false,
    );

    /* ---- Lock vault via the real command (Obsidian prefixes custom command ids) ---- */
    await obsidian.eval(`await app.commands.executeCommandById("geode:geode-lock"); return true;`);
    await expect.poll(() => cachedInStore(obsidian), { timeout: 15_000 }).toBe(false);
    await expect
      .poll(() => obsidian.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"), {
        timeout: 10_000,
      })
      .toBe(false);

    /* Re-unlock so the cache is rewritten, then seed the legacy in-vault file
       to prove the migration deletes it on next load. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    expect(await cachedInStore(obsidian), "cache in local storage after re-unlock").toBe(true);
    await obsidian.eval(`
      const geode = app.plugins.plugins.geode;
      const dir = geode.manifest.dir ?? app.vault.configDir + "/plugins/" + geode.manifest.id;
      await app.vault.adapter.write(dir + "/.geode_key_cache.json",
        JSON.stringify({ content_key: "x", mac_key: "y", nonce_key: "z", cached_at: Date.now() }));
      return true;
    `);
    expect(existsSync(await legacyCachePath(obsidian)), "legacy file seeded").toBe(true);
    await obsidian.close();

    /* ---- Restart: migration deletes the legacy file; the local-storage cache
       auto-unlocks the vault (no passphrase). ---- */
    const restarted = await launchObsidian({
      vaultDir: obsidian.vaultDir,
      userDataDir: obsidian.userDataDir,
      geodeSettings: {
        serverUrl: server.url,
        vaultId: server.vaultId,
        deviceId: device.deviceId,
        deviceToken: device.token,
        salt: server.salt,
        debugLogging: true,
      },
      keepVaultDir: true,
      keepUserDataDir: true,
    });
    try {
      await expect
        .poll(async () => !existsSync(await legacyCachePath(restarted)), { timeout: 30_000 })
        .toBe(true, "migration must delete the legacy in-vault cache file");
      await waitForUnlocked(restarted);
      expect(await cachedInStore(restarted), "cache survives restart").toBe(true);
      expect(
        existsSync(await legacyCachePath(restarted)),
        "no in-vault cache after unlock + restart",
      ).toBe(false);

      /* ---- Leave vault via the settings button (real UI seam) clears the store. ---- */
      await restarted.eval(`
        if (app.setting && typeof app.setting.close === "function") app.setting.close();
        app.setting.open();
        app.setting.openTabById("geode");
        return "ok";
      `);
      await restarted.win.locator(".geode-advanced-heading").click();
      const leaveBtn = restarted.win.locator('[data-testid="geode-settings-leave"]');
      await expect(leaveBtn).toBeVisible({ timeout: 10_000 });
      await leaveBtn.click();
      await expect(restarted.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
      await restarted.win.locator('[data-testid="geode-confirm-yes"]').click();

      /* After leave the cache must be gone from per-device storage. */
      await expect.poll(() => cachedInStore(restarted), { timeout: 15_000 }).toBe(false);

      /* No [error] log lines. */
      const errorCount = await restarted.eval<number>(
        `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error").length`,
      );
      expect(errorCount, `expected no log errors after lock/leave, found ${errorCount}`).toBe(0);
    } finally {
      await restarted.close();
    }
  } finally {
    await obsidian.close();
    await rm(obsidian.userDataDir, { recursive: true, force: true });
    await rm(obsidian.vaultDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});
