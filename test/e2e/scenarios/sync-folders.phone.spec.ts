import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "test-passphrase";

// #342 (phone): open the Sync folders Manage tree on device, toggle a folder,
// screenshot. The row summary updates in place.

test("sync folders manage tree (phone)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("sync-folders");

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
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    // A throwaway folder so the tree has something to toggle (removed at the end).
    await obsidian.eval(`
      (async () => {
        if (!(await app.vault.adapter.exists("Geode342"))) await app.vault.createFolder("Geode342");
        if (!app.vault.getAbstractFileByPath("Geode342/shot.md")) {
          await app.vault.create("Geode342/shot.md", "phone shot");
        }
        return true;
      })()
    `);

    // Open the Geode settings tab.
    await obsidian.eval(`
      app.setting?.open?.();
      app.setting?.openTabById?.("geode");
      return true;
    `);
    await obsidian.win.locator('[data-testid="geode-settings-folders-row"]').waitFor({
      timeout: 15_000,
    });
    await obsidian.screenshot(shotPath("row.phone.png"));

    // Open the Manage tree.
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-settings-folders-manage"]')?.click(); return true;`,
    );
    await obsidian.win.locator('[data-testid="geode-folder-row"][data-path="Geode342"]').waitFor({
      timeout: 15_000,
    });
    await obsidian.screenshot(shotPath("manage-tree.phone.png"));

    // Toggle the folder off, then back on (leave the vault's scope unchanged).
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-folder-toggle"][data-path="Geode342"]')?.click(); return true;`,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    const rowText = await obsidian.eval(
      `document.querySelector('[data-testid="geode-settings-folders-row"] .setting-item-description')?.textContent ?? ""`,
    );
    expect(rowText).toContain("Geode342/");
    await obsidian.screenshot(shotPath("row-excluded.phone.png"));

    await obsidian.eval(
      `document.querySelector('[data-testid="geode-folder-toggle"][data-path="Geode342"]')?.click(); return true;`,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    const rowText2 = await obsidian.eval(
      `document.querySelector('[data-testid="geode-settings-folders-row"] .setting-item-description')?.textContent ?? ""`,
    );
    expect(rowText2).toBe("All folders sync");

    // Clean up the throwaway folder.
    await obsidian.eval(`
      (async () => {
        const f = app.vault.getAbstractFileByPath("Geode342/shot.md");
        if (f) await app.vault.delete(f);
        const dir = app.vault.getAbstractFileByPath("Geode342");
        if (dir) await app.vault.delete(dir);
        return true;
      })()
    `);
  } finally {
    await obsidian.close();
    await server.stop?.();
  }
});
