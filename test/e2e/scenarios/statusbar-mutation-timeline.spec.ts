import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { upsertVaultFile } from "../helpers/geode";
import { waitAckHoldExpired } from "../helpers/waits";

// #144: the real dirty→pushing→synced timeline, recorded by a MutationObserver.

const PASSPHRASE = "realflow-passphrase";
const FILE_PATH = "notes/realflow.md";

test("status bar real-flow: MutationObserver timeline captures dirty→pushing→synced", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("realflow");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    /* --- 1. Reach a STABLE synced baseline (ok and NOT spinning: the startup
     * config commits push with ok+spin, so "ok" alone matches pushing too) --- */
    await expect.poll(
      async () =>
        await obsidian.eval<boolean>(
          `(() => { const el = document.querySelector('[data-testid="geode-statusbar"]'); const c = el ? el.classList : null; return !!c && c.contains("geode-statusbar-ok") && !c.contains("geode-statusbar-spin"); })()`,
        ),
      { timeout: 60_000 },
    ).toBe(true);
    /* #420: wait out the startup ack's green hold. */
    await waitAckHoldExpired(obsidian.win);

    /* --- 2. Install MutationObserver timeline recorder (BEFORE the edit) --- */
    await obsidian.eval(`
      (() => {
        const el = document.querySelector('[data-testid="geode-statusbar"]');
        window.__geodeStates = [];
        const classify = () => {
          const c = el.className;
          const tip = el.getAttribute('aria-label') || el.title || '';
          let state = 'unknown';
          if (c.includes('geode-statusbar-locked')) state = 'locked';
          else if (c.includes('geode-statusbar-error')) state = 'error';
          else if (c.includes('geode-statusbar-dirty')) state = 'dirty';
          else if (c.includes('geode-statusbar-ok') && c.includes('geode-statusbar-spin')) state = 'pushing';
          else if (c.includes('geode-statusbar-syncing')) state = 'syncing';
          else if (c.includes('geode-statusbar-ok')) state = 'synced';
          return { state, tip };
        };
        const record = () => {
          const s = classify();
          const arr = window.__geodeStates;
          const last = arr[arr.length - 1];
          if (!last || last.state !== s.state) arr.push({ state: s.state, tip: s.tip, t: Date.now() });
        };
        record();
        window.__geodeObs = new MutationObserver(record);
        window.__geodeObs.observe(el, { attributes: true, attributeFilter: ['class', 'aria-label'], childList: true, subtree: true });
        return true;
      })()
    `);

    /* --- 3. REAL edit: create then modify the file (fires real vault events → VaultEventHandler → updateDirty) --- */
    await upsertVaultFile(obsidian, FILE_PATH, "# realflow\ninitial\n");
    await upsertVaultFile(obsidian, FILE_PATH, "# realflow\ninitial\nedited\n");

    /* --- 4. Wait for the NATURAL push to complete (5s debounce + drain, no manual handlePendingOps) --- */
    await expect.poll(
      async () =>
        await obsidian.eval<number>(
          `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
            JSON.stringify(FILE_PATH)
          })?.last_seen_version ?? 0`,
        ),
      { timeout: 60_000 },
    ).toBeGreaterThan(0);

    /* Let the tail settle back to synced */
    await expect.poll(
      async () => {
        const arr = await obsidian.eval<Array<{ state: string }>>(`window.__geodeStates || []`);
        return arr.length ? arr[arr.length - 1].state : "";
      },
      { timeout: 30_000 },
    ).toBe("synced");

    /* --- 5. Read the recorded timeline and log it for visibility --- */
    const timeline = await obsidian.eval<Array<{ state: string; tip: string; t: number }>>(
      `window.__geodeStates || []`,
    );
    const states = timeline.map((e) => e.state);
    console.log("STATUS BAR TIMELINE:", JSON.stringify(timeline));
    test.info().annotations.push({ type: "timeline", description: states.join(" -> ") });

    /* --- 6. Assert the real-flow sequence --- */
    expect(states, "amber dirty state must appear on a real edit").toContain("dirty");
    expect(states, "pushing state must appear when the debounced flush pushes").toContain(
      "pushing",
    );

    const firstDirty = states.indexOf("dirty");
    const pushingAfterDirty = states.indexOf("pushing", firstDirty + 1);
    expect(pushingAfterDirty, "pushing must occur after the dirty state").toBeGreaterThan(
      firstDirty,
    );

    /* Clobber check: the synced checkmark must NOT appear between dirty and pushing */
    const between = states.slice(firstDirty + 1, pushingAfterDirty);
    expect(between, "synced checkmark must not flash between dirty and pushing (clobber bug)").not
      .toContain("synced");

    /* Ends synced */
    expect(states[states.length - 1]).toBe("synced");
  } finally {
    await obsidian.eval(
      `(() => { if (window.__geodeObs) window.__geodeObs.disconnect(); return true; })()`,
    ).catch(() => {});
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
