import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitAckHoldExpired, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";

// #141: on-device: every status-bar state, driven from one session.

const PASSPHRASE = "states-passphrase";

test("status bar driven states in a single session", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("states");

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
    /* Wait for the plugin to be loaded before we can call unlockVault. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    /* Unlock and wait for live/synced baseline so the sync loop isn't racing us. */
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );

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

    /* 5. Clicking the status icon opens the status menu, not the debug pane (#430) */
    /* Dismiss any stacked modals: the startup modal, or Obsidian's own settings/"rate the app"
       dialog which pops intermittently. Playwright .click()/Escape don't close modals on the mobile
       WebView (1.13.4), so use the eval helper for a deterministic close. */
    await dismissModals(obsidian);
    const finalCount = await obsidian.win.locator(".modal-container").count();
    expect(finalCount).toBe(0);
    await obsidian.eval(
      'document.querySelector("[data-testid=geode-statusbar]").click(); return true;',
    );
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
