import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { readGeodeStatusBar, waitAckHoldExpired, waitForStatusBar } from "../helpers/waits";

// #141: every status-bar state, driven from one session.

const PASSPHRASE = "states-passphrase";

test("status bar driven states in a single session", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("states");

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
    /* Wait for the plugin to be loaded before we can call unlockVault. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* Unlock and wait for live/synced baseline so the sync loop isn't racing us. */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    // #420: wait out the baseline commit-ack's green hold.
    await waitAckHoldExpired(obsidian.win);

    /* 1. syncing... (no progress) */
    const syncingText = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updateState("syncing"); return sb.statusEl.title; })()`,
    );
    expect(syncingText).toBe("Geode: syncing...");

    /* 2. syncing... N/M (with progress) */
    const progressText = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updateSyncingProgress(3, 7); return sb.statusEl.title; })()`,
    );
    expect(progressText).toBe("Geode: syncing... 3/7");

    /* 3. pushing (N pending): state "live" + pendingCount > 0 */
    const pushingText = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.lastAckAt = 0; sb.clearSyncingProgress(); sb.updateState("live"); sb.updatePending(4); return sb.statusEl.title; })()`,
    );
    expect(pushingText).toBe("Geode: pushing (4)");

    /* 4. conflicts override everything */
    const conflictText = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updateConflicts(2); return sb.statusEl.title; })()`,
    );
    expect(conflictText).toBe("Geode: 2 conflicts");

    /* Conflicts clear → returns to the underlying live+pending label (pending is still 4) */
    const afterConflictClear = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.lastAckAt = 0; sb.updateConflicts(0); return sb.statusEl.title; })()`,
    );
    expect(afterConflictClear).toBe("Geode: pushing (4)");

    /* 5. Clicking the status bar opens the status menu, not the debug pane (#430) */
    /* Dismiss any stacked modals (startup modal may have spawned a passphrase modal). */
    const modalTexts = await obsidian.win.locator(".modal-container").allTextContents();
    for (let i = 0; i < 5; i++) {
      const count = await obsidian.win.locator(".modal-container").count();
      if (count === 0) break;
      const closeBtn = obsidian.win.locator(".modal-close-button").last();
      if ((await closeBtn.count()) > 0) {
        await closeBtn.click();
      } else {
        await obsidian.win.keyboard.press("Escape");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const finalCount = await obsidian.win.locator(".modal-container").count();
    await expect(finalCount, JSON.stringify(modalTexts)).toBe(0);
    const statusBarItem = obsidian.win.locator('[data-testid="geode-statusbar"]');
    await statusBarItem.click();
    await expect(obsidian.win.locator(".menu .menu-item-title")).toHaveText([
      "Pause",
      "Sync activity",
      "Conflicts",
      "Deleted files",
      "Devices",
      "Geode settings",
    ]);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
