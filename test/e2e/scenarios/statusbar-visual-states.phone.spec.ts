import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import type { PhoneInstance } from "../fixtures/phone-obsidian";
import { waitAckHoldExpired } from "../helpers/waits";

// #141: on-device: per state classes, icons and tooltips.

const PASSPHRASE = "flow-passphrase";

/* Atomic snapshot: set state AND capture { title, classes, icon } in one eval.
 * Avoids race with the live sync engine clobbering the mobile status button between separate reads. */
async function atomicSnapshot(
  obsidian: PhoneInstance,
  setupFn: string,
): Promise<{ title: string; classes: string[]; icon: string }> {
  return await obsidian.eval(
    `(() => {
      const sb = app.plugins.plugins.geode.statusBar;
      ${setupFn}
      const svg = sb.mobileEl.querySelector("span svg");
      return {
        title: sb.mobileEl.getAttribute("aria-label") || sb.mobileEl.title || "",
        classes: [...sb.mobileEl.classList],
        icon: svg ? svg.getAttribute("class") : "",
      };
    })()`,
  );
}

/* Read-only snapshot (for steps that use expect.poll). */
async function readSnapshot(
  obsidian: PhoneInstance,
): Promise<{ title: string; classes: string[]; icon: string }> {
  return await obsidian.eval(
    `(() => {
      const sb = app.plugins?.plugins?.geode?.statusBar;
      if (!sb) return { title: "", classes: [], icon: "" };
      const svg = sb.mobileEl.querySelector("span svg");
      return {
        title: sb.mobileEl.getAttribute("aria-label") || sb.mobileEl.title || "",
        classes: [...sb.mobileEl.classList],
        icon: svg ? svg.getAttribute("class") : "",
      };
    })()`,
  );
}

test("status bar state flow: visual classes, icons, tooltips", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("statusbar-visual-states");

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
    /* --- 1. Locked baseline --- */
    await expect.poll(async () => (await readSnapshot(obsidian)).classes, { timeout: 30_000 })
      .toContain("geode-statusbar-locked");
    const locked = await readSnapshot(obsidian);
    expect(locked.classes).toContain("geode-statusbar-locked");
    expect(locked.icon).toContain("lucide-lock-keyhole");
    expect(locked.title).toBe("Geode: locked");

    /* --- 2. Unlock and reach synced baseline --- */
    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* Assert all synced properties atomically INSIDE the poll: a separate post-poll
     * read can catch a background reconcile mid-flip (icon → refresh-cw). */
    await expect.poll(async () => {
      const s = await readSnapshot(obsidian);
      return s.title.startsWith("Geode: synced") &&
        s.icon.includes("lucide-circle-check") &&
        s.classes.includes("geode-statusbar-ok") &&
        !s.classes.includes("geode-statusbar-spin");
    }, { timeout: 60_000 }).toBe(true);

    /* #420: wait out the baseline ack's green hold. */
    await waitAckHoldExpired(obsidian.win);

    /* --- 3. DIRTY state --- (each step sets the FULL competing baseline so the live
       sync engine's real counters: e.g. pendingCount from a background push: can't
       outrank the manually-driven state; the atomic eval sets+reads synchronously) */
    const dirty = await atomicSnapshot(
      obsidian,
      `
      sb.updateState("live");
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(2);
    `,
    );
    expect(dirty.title).toBe("Geode: 2 changes pending");
    expect(dirty.classes).toContain("geode-statusbar-dirty");
    // #420: dirty spins from the first save (no ack yet).
    expect(dirty.classes).toContain("geode-statusbar-spin");
    expect(dirty.icon).toContain("lucide-refresh-cw");

    /* --- 4. PUSHING state --- */
    const pushing = await atomicSnapshot(
      obsidian,
      `sb.updateState("live"); sb.updateConflicts(0); sb.updateDirty(0); sb.updatePending(2);`,
    );
    expect(pushing.title).toBe("Geode: pushing (2)");
    expect(pushing.classes).toContain("geode-statusbar-ok");
    expect(pushing.classes).toContain("geode-statusbar-spin");
    expect(pushing.icon).toContain("lucide-refresh-cw");

    /* --- 5. Clear pending+dirty → back to synced --- */
    const afterClear = await atomicSnapshot(
      obsidian,
      `
      sb.updateState("live");
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.updateLastSync();
    `,
    );
    expect(afterClear.title).toMatch(/^Geode: synced/);
    expect(afterClear.icon).toContain("lucide-circle-check");
    expect(afterClear.classes).toContain("geode-statusbar-ok");

    /* --- 6. SYNCING state with progress --- */
    const syncing = await atomicSnapshot(
      obsidian,
      `
      sb.updateConflicts(0);
      sb.updatePending(0);
      sb.updateDirty(0);
      sb.updateState("syncing");
      sb.updateSyncingProgress(3, 7);
    `,
    );
    expect(syncing.title).toBe("Geode: syncing... 3/7");
    expect(syncing.classes).toContain("geode-statusbar-syncing");
    expect(syncing.classes).toContain("geode-statusbar-spin");
    expect(syncing.icon).toContain("lucide-refresh-cw");

    /* --- 7. CONFLICT override --- */
    const conflict = await atomicSnapshot(
      obsidian,
      `
      sb.clearSyncingProgress();
      sb.updateState("live");
      sb.updateConflicts(1);
    `,
    );
    expect(conflict.title).toBe("Geode: 1 conflict");
    // #432: calmer conflicts icon: git-merge in orange, not the red error state.
    expect(conflict.classes).toContain("geode-statusbar-conflict");
    expect(conflict.classes).not.toContain("geode-statusbar-error");
    expect(conflict.icon).toContain("lucide-git-merge");

    /* Conflicts clear → returns to underlying live (synced) state */
    const afterConflictClear = await atomicSnapshot(
      obsidian,
      `sb.updateState("live"); sb.updateConflicts(0); sb.updatePending(0); sb.updateDirty(0);`,
    );
    expect(afterConflictClear.title).toMatch(/^Geode: synced/);
    expect(afterConflictClear.classes).not.toContain("geode-statusbar-error");
    expect(afterConflictClear.classes).not.toContain("geode-statusbar-dirty");
    expect(afterConflictClear.icon).not.toContain("lucide-circle-alert");

    /* #420's no-flash path is hard-asserted in spinner-continuity. */
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
