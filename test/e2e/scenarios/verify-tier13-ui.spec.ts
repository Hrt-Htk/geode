import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "verify-tier13-pass";

async function dismissAllModals(win: Page) {
  for (let i = 0; i < 5; i++) {
    const count = await win.locator(".modal-container").count();
    if (count === 0) break;
    const closeBtn = win.locator(".modal-close-button").last();
    if ((await closeBtn.count()) > 0) await closeBtn.click();
    else await win.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function openSettings(obsidian: { eval: (s: string) => Promise<unknown> }) {
  await obsidian.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
}

test("verify tier1-3 UI: #246 blocked version warning, #169 lock feedback, #168 reconcile feedback", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("verify-tier13");

  const obsidian = await launchObsidian({
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

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissAllModals(obsidian.win);

    /* ───────── #246: blocked version-awareness (statusbar icon + settings banner) ─────────
       Drive the new strict-gate model: a refused plugin version is "blocked" (sync disabled),
       not "outdated". Set versionStatus, push it to the status bar, and re-render settings. This
       renders the real StatusBar.resolveIcon() blocked branch and settings renderVersionWarning()
       banner (heading "Update required" + the update copy, #625). */
    await openSettings(obsidian);
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.versionStatus = { kind: "blocked", side: "plugin" };
      p.statusBar.setVersionStatus(p.versionStatus);
      p.settingTab.display();
      return true;
    `);

    /* settings banner: heading "Update required" + the update desc must be present */
    const banner = obsidian.win.locator(".setting-item").filter({ hasText: "Update required" });
    await expect(banner.first()).toBeVisible({ timeout: 10_000 });
    const bannerText = await banner.first().textContent();
    expect(bannerText).toContain("Update the plugin, then reload Obsidian.");
    await obsidian.win.screenshot({ path: shotPath("246-settings-version-banner.png") });

    /* status bar: blocked → error color class + tooltip naming the fix */
    const statusEl = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await expect(statusEl).toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    const tooltip = await statusEl.getAttribute("title");
    expect(tooltip).toMatch(/update the plugin/i);
    /* close settings so the status bar is unobstructed for the shot */
    await obsidian.eval(`app.setting.close(); return true;`);
    await obsidian.win.screenshot({ path: shotPath("246-statusbar-blocked.png") });

    /* the REAL blocked path: dispatching the transport "blocked" event runs main.ts's listener,
       which sets versionStatus AND fires the guarded one-off Notice (setVersionStatus alone does
       not). Verify the toast renders the update copy and fires exactly once. */
    await obsidian.eval(`
      app.plugins.plugins.geode.transport.dispatchEvent(new CustomEvent("blocked", {
        detail: { server_version: "0.9.2", client_version: "0.5.0" },
      }));
      return true;
    `);
    const blockedNotice = obsidian.win.locator(".notice").filter({
      hasText: /needs an update to keep syncing/i,
    });
    await expect(blockedNotice.first()).toBeVisible({ timeout: 10_000 });
    const blockedNoticeText = await blockedNotice.first().textContent();
    expect(blockedNoticeText).toContain("Update the plugin, then reload Obsidian.");
    await obsidian.win.screenshot({ path: shotPath("246-blocked-notice.png") });
    /* one-off guard (blockedNoticeShown): a second blocked event must not add a second toast */
    await obsidian.eval(`
      app.plugins.plugins.geode.transport.dispatchEvent(new CustomEvent("blocked", {
        detail: { server_version: "0.9.2", client_version: "0.5.0" },
      }));
      return true;
    `);
    expect(await blockedNotice.count()).toBe(1);
    /* dismiss the toast so it doesn't bleed into later screenshots */
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );

    /* clear the injected mismatch back to ok so it doesn't bleed into later steps */
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.versionStatus = { kind: "ok" };
      p.statusBar.setVersionStatus(p.versionStatus);
      return true;
    `);

    /* ───────── #529: compatible version difference = update hint, sync keeps running ─────────
       Drive the REAL hello_ack handler (onServerVersion): a newer server version must show the
       "Plugin update available" hint in the version banner AND the sync-status row, keep the
       status bar on the synced icon (NOT error), and an older server flips the copy. */
    await openSettings(obsidian);
    await obsidian.eval(`
      const p = app.plugins.plugins.geode;
      p.onServerVersion("9.9.9");
      return true;
    `);
    const hintBanner = obsidian.win.locator(".setting-item").filter({
      hasText: "Update available",
    });
    await expect(hintBanner.first()).toBeVisible({ timeout: 10_000 });
    expect(await hintBanner.first().textContent()).toContain("Plugin update available");
    /* the settings sync-status row carries the same hint copy */
    const statusRow = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect
      .poll(async () => await statusRow.first().textContent(), { timeout: 10_000 })
      .toContain("Plugin update available");
    /* status bar keeps the synced icon: sync is not blocked */
    const hintStatusEl = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await expect(hintStatusEl).not.toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    await obsidian.win.screenshot({ path: shotPath("529-settings-version-hint.png") });
    /* server older than plugin → "Server update available" */
    await obsidian.eval(`
      app.plugins.plugins.geode.onServerVersion("0.0.1");
      return true;
    `);
    await expect
      .poll(async () => await hintBanner.first().textContent(), { timeout: 10_000 })
      .toContain("Server update available");
    /* clear back to ok so later steps are unaffected */
    await obsidian.eval(`
      app.plugins.plugins.geode.onServerVersion(app.plugins.plugins.geode.manifest.version);
      return true;
    `);

    /* ───────── #169: "Lock vault" now emits a success Notice ───────── */
    await openSettings(obsidian);
    await obsidian.win.locator('[data-testid="geode-settings-lock"]').click();
    const lockNotice = obsidian.win.locator(".notice").filter({ hasText: /vault locked/i });
    await expect(lockNotice.first()).toBeVisible({ timeout: 10_000 });
    await obsidian.win.screenshot({ path: shotPath("169-lock-vault-notice.png") });

    /* re-unlock for the reconcile step */
    await obsidian.win.locator('[data-testid="geode-settings-unlock"]').click();
    const modal = obsidian.win.locator(".modal:has(:text('Unlock Geode'))");
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await modal.locator('[data-testid="geode-passphrase-input"]').press("Enter");
    await expect(modal).not.toBeVisible({ timeout: 15_000 });
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* ───────── #168: "Reconcile now" completes with a truthful success Notice ───────── */
    await openSettings(obsidian);
    await obsidian.win.locator('[data-testid="geode-settings-reconcile"]').click();
    /* the reconcile-complete notice should appear (now that reconcileNow awaits real work) */
    const reconcileNotice = obsidian.win.locator(".notice").filter({
      hasText: /reconcile complete/i,
    });
    await expect(reconcileNotice.first()).toBeVisible({ timeout: 30_000 });
    /* and no error notice */
    const errNotices = await obsidian.win.locator(
      '.notice:has-text("failed"), .notice:has-text("Error")',
    ).count();
    expect(errNotices).toBe(0);
    await obsidian.win.screenshot({ path: shotPath("168-reconcile-complete-notice.png") });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});

/* #529: real seam: the installed plugin reports a different version (manifest
   rewritten to 9.9.9 in the vault before Obsidian loads) against the normal
   throwaway server (0.25.1). Compatible → sync must reach live with no block, a
   real file commit must reach the server, and the settings sync-status row must
   show the "Server update available" hint. No injected state anywhere. */
test("verify tier1-3 UI: #529 real-seam version difference syncs and shows the update hint", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("verify-tier13-529");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    pluginVersion: "9.9.9",
    unlockPassphrase: PASSPHRASE,
  });

  try {
    /* The plugin reports 9.9.9 through the real handshake; the old exact-match
       gate would have blocked here. It must reach live (synced icon), not error. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    const statusEl = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await expect(statusEl).not.toHaveClass(/geode-statusbar-error/, { timeout: 10_000 });
    /* the plugin learned the real (older) server version from hello_ack */
    const serverVersion = await obsidian.eval<string>(
      `app.plugins.plugins.geode.transport.getServerVersion()`,
    );
    expect(serverVersion).not.toBe("9.9.9");
    expect(/^\d+\.\d+\.\d+$/.test(serverVersion)).toBe(true);

    /* A real file written in the vault must reach the server through the live sync. */
    await obsidian.eval(
      `await app.vault.create("real-seam.md", "# real seam\\ntest\\n"); return true;`,
    );
    await expect
      .poll(async () => {
        const res = await fetch(`${server.url}/vaults/${server.vaultId}/heads`, {
          headers: { authorization: `Bearer ${device.token}` },
        });
        if (!res.ok) return 0;
        return (await res.text()).trim().split("\n").filter(Boolean).length;
      }, { timeout: 30_000 })
      .toBeGreaterThan(0);

    /* Open settings: the sync-status row must show the update hint (server older
       than plugin), and the version banner must too. */
    await openSettings(obsidian);
    const statusRow = obsidian.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect
      .poll(async () => await statusRow.first().textContent(), { timeout: 15_000 })
      .toContain("Server update available");
    const hintBanner = obsidian.win.locator(".setting-item").filter({
      hasText: "Update available",
    });
    await expect(hintBanner.first()).toBeVisible({ timeout: 10_000 });
    expect(await hintBanner.first().textContent()).toContain("Server update available");
    await obsidian.win.screenshot({ path: shotPath("529-realseam-settings-version-hint.png") });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
