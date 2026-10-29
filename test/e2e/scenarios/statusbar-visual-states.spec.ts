import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitAckHoldExpired } from "../helpers/waits";

// #141: per state: status-bar classes, icons and tooltips.

const PASSPHRASE = "flow-passphrase";

/* Helper: read the tooltip text (aria-label, falls back to title). */
async function readStatusBarTooltip(
  obsidian: Awaited<ReturnType<typeof launchObsidian>>,
): Promise<string> {
  return await obsidian.eval<string>(
    `(() => { const sb = app.plugins?.plugins?.geode?.statusBar; return sb ? (sb.statusEl.getAttribute("aria-label") || sb.statusEl.title || "") : ""; })()`,
  );
}

/* Helper: read the SVG icon's class list from inside the status bar. */
async function readStatusBarIcon(
  obsidian: Awaited<ReturnType<typeof launchObsidian>>,
): Promise<string> {
  return await obsidian.eval<string>(
    `(() => { const sb = app.plugins?.plugins?.geode?.statusBar; if (!sb) return ""; const svg = sb.statusEl.querySelector("span svg"); return svg ? svg.getAttribute("class") : ""; })()`,
  );
}

/* Helper: read the statusEl's CSS class list. */
async function readStatusBarClasses(
  obsidian: Awaited<ReturnType<typeof launchObsidian>>,
): Promise<string[]> {
  return await obsidian.eval<string[]>(
    `(() => { const sb = app.plugins?.plugins?.geode?.statusBar; return sb ? [...sb.statusEl.classList] : []; })()`,
  );
}

test("status bar state flow: visual classes, icons, tooltips", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("statusbar-visual-states");

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
    /* --- 1. Locked baseline --- */
    await expect.poll(async () => await readStatusBarClasses(obsidian), { timeout: 30_000 })
      .toContain("geode-statusbar-locked");

    const lockedClasses = await readStatusBarClasses(obsidian);
    expect(lockedClasses).toContain("geode-statusbar-locked");

    const lockedIcon = await readStatusBarIcon(obsidian);
    expect(lockedIcon).toContain("lucide-lock-keyhole");

    const lockedTooltip = await readStatusBarTooltip(obsidian);
    expect(lockedTooltip).toBe("Geode: locked");

    /* --- 2. Unlock and reach synced baseline --- */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* Wait for a STABLE synced baseline: icon + class must match on the same tick
     * so we don't catch a transient flip between syncing↔synced. */
    await expect
      .poll(
        async () => {
          const [icon, classes] = await Promise.all([
            readStatusBarIcon(obsidian),
            readStatusBarClasses(obsidian),
          ]);
          return icon.includes("lucide-circle-check") && classes.includes("geode-statusbar-ok")
            ? "stable"
            : "not-yet";
        },
        { timeout: 60_000 },
      )
      .toBe("stable");

    /* The bar flaps synced↔syncing on background reconcile ticks, so each read must
     * poll for a synced tick rather than take one racy snapshot. */
    await expect.poll(async () => await readStatusBarClasses(obsidian), { timeout: 30_000 })
      .toContain("geode-statusbar-ok");
    await expect.poll(async () => await readStatusBarIcon(obsidian), { timeout: 30_000 })
      .toContain("lucide-circle-check");
    await expect.poll(async () => await readStatusBarTooltip(obsidian), { timeout: 30_000 })
      .toMatch(/^Geode: synced/);

    /* #420: wait out the baseline ack's green hold. */
    await waitAckHoldExpired(obsidian.win);

    /* --- 3. DIRTY state --- */
    await obsidian.eval(`
      (() => {
        const sb = app.plugins.plugins.geode.statusBar;
        sb.updateState("live");
        sb.updateDirty(2);
        return sb.statusEl.title;
      })()
    `);

    const dirtyTitle = await readStatusBarTooltip(obsidian);
    expect(dirtyTitle).toBe("Geode: 2 changes pending");

    const dirtyClasses = await readStatusBarClasses(obsidian);
    expect(dirtyClasses).toContain("geode-statusbar-dirty");
    // #420: dirty spins from the first save (no ack yet).
    expect(dirtyClasses).toContain("geode-statusbar-spin");

    const dirtyIcon = await readStatusBarIcon(obsidian);
    expect(dirtyIcon).toContain("lucide-refresh-cw");

    /* --- 4. PUSHING state --- */
    const pushingTitle = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updatePending(2); return sb.statusEl.getAttribute("aria-label") || sb.statusEl.title; })()`,
    );
    expect(pushingTitle).toBe("Geode: pushing (2)");

    const pushingClasses = await readStatusBarClasses(obsidian);
    expect(pushingClasses).toContain("geode-statusbar-ok");
    expect(pushingClasses).toContain("geode-statusbar-spin");

    const pushingIcon = await readStatusBarIcon(obsidian);
    expect(pushingIcon).toContain("lucide-refresh-cw");

    /* --- 5. Clear pending+dirty → back to synced --- */
    await obsidian.eval(`
      (() => {
        const sb = app.plugins.plugins.geode.statusBar;
        sb.updatePending(0);
        sb.updateDirty(0);
        sb.updateLastSync();
        return sb.statusEl.getAttribute("aria-label") || sb.statusEl.title;
      })()
    `);

    const afterClearTitle = await readStatusBarTooltip(obsidian);
    expect(afterClearTitle).toMatch(/^Geode: synced/);

    const afterClearIcon = await readStatusBarIcon(obsidian);
    expect(afterClearIcon).toContain("lucide-circle-check");

    const afterClearClasses = await readStatusBarClasses(obsidian);
    expect(afterClearClasses).toContain("geode-statusbar-ok");

    /* --- 6. SYNCING state with progress --- */
    const syncingTitle = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updateState("syncing"); sb.updateSyncingProgress(3, 7); return sb.statusEl.getAttribute("aria-label") || sb.statusEl.title; })()`,
    );
    expect(syncingTitle).toBe("Geode: syncing... 3/7");

    const syncingClasses = await readStatusBarClasses(obsidian);
    expect(syncingClasses).toContain("geode-statusbar-syncing");
    expect(syncingClasses).toContain("geode-statusbar-spin");

    const syncingIcon = await readStatusBarIcon(obsidian);
    expect(syncingIcon).toContain("lucide-refresh-cw");

    /* --- 7. CONFLICT override --- */
    const conflictTitle = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.clearSyncingProgress(); sb.updateState("live"); sb.updateConflicts(1); return sb.statusEl.getAttribute("aria-label") || sb.statusEl.title; })()`,
    );
    expect(conflictTitle).toBe("Geode: 1 conflict");

    // #432: calmer conflicts icon: git-merge in orange, not the red error state.
    const conflictClasses = await readStatusBarClasses(obsidian);
    expect(conflictClasses).toContain("geode-statusbar-conflict");
    expect(conflictClasses).not.toContain("geode-statusbar-error");

    const conflictIcon = await readStatusBarIcon(obsidian);
    expect(conflictIcon).toContain("lucide-git-merge");

    /* Conflicts clear → returns to underlying live (synced) state */
    const afterConflictClearTitle = await obsidian.eval<string>(
      `(() => { const sb = app.plugins.plugins.geode.statusBar; sb.updateConflicts(0); return sb.statusEl.getAttribute("aria-label") || sb.statusEl.title; })()`,
    );
    expect(afterConflictClearTitle).toMatch(/^Geode: synced/);

    const afterConflictClearClasses = await readStatusBarClasses(obsidian);
    expect(afterConflictClearClasses).not.toContain("geode-statusbar-error");
    expect(afterConflictClearClasses).not.toContain("geode-statusbar-dirty");

    const afterConflictClearIcon = await readStatusBarIcon(obsidian);
    expect(afterConflictClearIcon).not.toContain("lucide-circle-alert");

    /* #420's no-flash path is hard-asserted in spinner-continuity. */
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
