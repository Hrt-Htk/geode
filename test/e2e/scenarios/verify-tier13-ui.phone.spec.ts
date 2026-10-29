import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "verify-tier13-phone-pass";

test("verify tier1-3 UI (phone): #246 blocked status banner renders natively on mobile", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("verify-tier13-phone");

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
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000).catch(() => {});

    /* Drive the #246 blocked path, then open the settings tab the mobile way. */
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.versionStatus = { kind: "blocked", side: "plugin" };
      p.statusBar && p.statusBar.setVersionStatus(p.versionStatus);
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      p.settingTab.display();
      return true;
    `);

    /* settings banner: heading "Update required" + the update desc must be present (#625) */
    const banner = obsidian.win.locator(".setting-item").filter({ hasText: "Update required" });
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });
    const bannerText = await banner.first().textContent();
    expect(bannerText).toContain("Update the plugin, then reload Obsidian.");

    /* mobile status icon: error class + aria-label naming the fix */
    const mobileStatus = obsidian.win.locator('[data-testid="geode-mobile-status"]');
    await expect(mobileStatus).toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    const label = await mobileStatus.first().getAttribute("aria-label");
    expect(label).toMatch(/update the plugin/i);

    /* Clear transient notices before the shot (mobile Notice spam). */
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach(n => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("246-phone-settings-version-banner.png"));

    /* #529: a compatible version difference shows the update hint, not a block */
    await obsidian.eval(`app.plugins.plugins.geode.onServerVersion("9.9.9"); return true;`);
    const hintBanner = obsidian.win.locator(".setting-item").filter({
      hasText: "Update available",
    });
    await expect(hintBanner.first()).toBeVisible({ timeout: 10_000 });
    expect(await hintBanner.first().textContent()).toContain("Plugin update available");
    await expect(mobileStatus).not.toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach(n => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("529-phone-settings-version-hint.png"));
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
