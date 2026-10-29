import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitAckHoldExpired, waitForStatusBar } from "../helpers/waits";
import { computeVerifier } from "../helpers/verifier";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #213: the sync status icon in the mobile toolbar, captured per state.

const PASSPHRASE = "status-icon-passphrase";

/**
 * Drive the status bar into a specific state, reset other fields, clear notices,
 * and screenshot the toolbar area.
 */
async function captureState(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  stateName: string,
  setupFn: (sb: any, plugin: any) => void,
) {
  // Reset all fields to a clean baseline first
  await obsidian.eval<void>(`
    (() => {
      const sb = app.plugins.plugins.geode.statusBar;
      const plugin = app.plugins.plugins.geode;
      // Reset counts
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(0);
      // Reset version status
      sb.setVersionStatus({ kind: "ok" });
      // Ensure unlocked (locked state sets this separately)
      plugin.isUnlocked = true;
      return true;
    })()
  `);

  // Apply the specific state setup
  await obsidian.eval<void>(`
    (() => {
      const sb = app.plugins.plugins.geode.statusBar;
      const plugin = app.plugins.plugins.geode;
      ${setupFn.toString().replace(/^.*?\{/, "").replace(/\}$/, "")}
      return true;
    })()
  `);

  // Small settle delay for CSS transitions
  await new Promise((r) => setTimeout(r, 300));

  // Clear any notices that might obscure the toolbar
  await obsidian.eval<void>(`
    document.querySelectorAll('.notice').forEach(n => n.remove());
    return true;
  `);

  // Screenshot the toolbar area
  await obsidian.screenshot(shotPath(`${stateName}.png`));

  // Verify the file was written and capture computed color for programmatic verification
  const iconInfo = await obsidian.eval<{ icon: string; colorClass: string; computedColor: string }>(
    `
    (() => {
      const el = document.querySelector('[data-testid="geode-mobile-status"]');
      if (!el) return { icon: "MISSING", colorClass: "MISSING", computedColor: "MISSING" };
      const classes = el.className.split(" ");
      const svg = el.querySelector("svg");
      const paths = svg ? svg.querySelectorAll("path") : [];
      const firstPathStroke = paths.length > 0 ? getComputedStyle(paths[0]).stroke : "unknown";
      // Extract the color class
      const colorMatch = classes.find(c => c.startsWith("geode-statusbar-") && c !== "geode-statusbar-spin");
      return {
        icon: svg ? (svg.getAttribute("data-lucide") || "unknown") : "no-svg",
        colorClass: colorMatch || "none",
        computedColor: firstPathStroke,
      };
    })()
  `,
  );

  console.log(
    `  [${stateName}] icon=${iconInfo.icon} colorClass=${iconInfo.colorClass} computedStroke=${iconInfo.computedColor}`,
  );
}

test("mobile status icon screenshot loop", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("status-icon");

  // Compute a real verifier so unlockVault exercises the actual checkVerifier path.
  const verifier = await computeVerifier(
    PASSPHRASE,
    server.salt,
    { ops: TEST_ARGON2_PARAMS.ops, mem: TEST_ARGON2_PARAMS.mem },
  );

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      verifier,
      argon2Params: TEST_ARGON2_PARAMS,
    },
    keepStartupModal: true,
  });

  try {
    // Wait for locked state
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    // Dismiss all modals (Obsidian auto-opens Settings on fresh vaults)
    await dismissModals(obsidian);

    // Open passphrase modal and unlock
    await obsidian.eval<void>(`app.commands.executeCommandById("geode:geode-unlock")`);
    const passphraseModal = obsidian.win.locator(
      '.modal:has([data-testid="geode-passphrase-input"])',
    ).last();
    await expect(passphraseModal).toBeVisible({ timeout: 10_000 });

    await evalSetValue(obsidian, '[data-testid="geode-passphrase-input"]', PASSPHRASE);
    // Click submit: NOT press Enter (Android WebView password input gotcha)
    await evalClick(obsidian, '[data-testid="geode-passphrase-submit"]');

    // Wait for modal to close
    await expect(passphraseModal).not.toBeVisible({ timeout: 30_000 });

    // Wait for synced state
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    // #420: wait out the startup commits' green hold.
    await waitAckHoldExpired(obsidian.win);

    // Dismiss any remaining modals
    await dismissModals(obsidian);

    // === Capture all 8 states ===

    // 1. synced: state 'live', all counts 0, updateLastSync()
    await captureState(obsidian, "synced", (sb, plugin) => {
      sb.updateState("live");
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.updateConflicts(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
      sb.updateLastSync();
    });

    // 2. dirty: state 'live', dirty=2, pending=0
    await captureState(obsidian, "dirty", (sb, plugin) => {
      sb.updateState("live");
      sb.updateDirty(2);
      sb.updatePending(0);
      sb.updateConflicts(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
    });

    // 3. pushing: state 'live', pending=3
    await captureState(obsidian, "pushing", (sb, plugin) => {
      sb.updateState("live");
      sb.updatePending(3);
      sb.updateDirty(0);
      sb.updateConflicts(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
    });

    // 4. syncing: state 'syncing'
    await captureState(obsidian, "syncing", (sb, plugin) => {
      sb.updateState("syncing");
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.updateConflicts(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
    });

    // 5. offline: state 'disconnected'
    await captureState(obsidian, "offline", (sb, plugin) => {
      sb.updateState("disconnected");
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.updateConflicts(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
    });

    // 6. conflict: state 'live', conflicts=1
    await captureState(obsidian, "conflict", (sb, plugin) => {
      sb.updateState("live");
      sb.updateConflicts(1);
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = true;
    });

    // 7. blocked: setVersionStatus({kind:'blocked',own:'0.5.0',server:'0.9.2'})
    await captureState(obsidian, "blocked", (sb, plugin) => {
      sb.updateState("live");
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.setVersionStatus({ kind: "blocked", side: "plugin" });
      plugin.isUnlocked = true;
    });
    // hard assert the blocked tooltip on the mobile aria-label (#625 copy)
    const blockedLabel = await obsidian.win
      .locator('[data-testid="geode-mobile-status"]')
      .first()
      .getAttribute("aria-label");
    expect(blockedLabel).toMatch(/update the plugin/i);

    // 8. locked: set isUnlocked=false then tick()
    await captureState(obsidian, "locked", (sb, plugin) => {
      sb.updateState("live");
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.setVersionStatus({ kind: "ok" });
      plugin.isUnlocked = false;
      sb.tick();
    });

    console.log(`\nAll 8 screenshots captured in test/e2e/screenshots/`);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
