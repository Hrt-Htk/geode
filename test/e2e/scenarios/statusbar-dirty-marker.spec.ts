import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";

// #141: an incoming remote version never wipes the amber dirty marker.

const PASSPHRASE = "clobber-passphrase";
const FILE_A = "notes/device-a.md";
const FILE_B = "notes/device-b.md";

test("status bar clobber: remote sync must not wipe dirty marker while A has unpushed edits", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    /* --- 1. Both devices unlocked; A reaches synced baseline --- */
    await expect.poll(
      async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
      { timeout: 60_000 },
    ).toBe(true);
    await expect.poll(
      async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
      { timeout: 60_000 },
    ).toBe(true);
    await expect.poll(
      async () =>
        await pair.A.eval<string[]>(
          `(() => { const el = document.querySelector('[data-testid="geode-statusbar"]'); return el ? [...el.classList] : []; })()`,
        ),
      { timeout: 60_000 },
    ).toContain("geode-statusbar-ok");

    /* --- 2. Install MutationObserver timeline recorder on A (BEFORE any edit) --- */
    await pair.A.eval(`
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

    /* --- 3. A makes a REAL local edit (amber dirty). Do NOT commit A: let debounce hold it. --- */
    await upsertVaultFile(pair.A, FILE_A, "# device a\ninitial\n");
    await upsertVaultFile(pair.A, FILE_A, "# device a\ninitial\nedited\n");

    /* --- 4. Confirm A actually showed amber before proceeding --- */
    await expect.poll(
      async () => {
        const arr = await pair.A.eval<Array<{ state: string }>>(`window.__geodeStates || []`);
        return arr.map((e) => e.state);
      },
      { timeout: 20_000 },
    ).toContain("dirty");

    /* --- 5. WHILE A is still in its debounce window, B pushes a DIFFERENT file to the server. --- */
    await upsertVaultFile(pair.B, FILE_B, "# device b\nfrom b\n");
    await commitPath(pair.B, FILE_B);

    /* --- 6. Wait until A RECEIVES B's file (fires onSyncStatus("sync") on A). --- */
    await expect.poll(
      async () =>
        await pair.A.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(FILE_B)})`),
      { timeout: 60_000 },
    ).toBe(true);

    /* --- 7. Let A's own edit flush/push naturally, then settle to synced. --- */
    await expect.poll(
      async () =>
        await pair.A.eval<number>(
          `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
            JSON.stringify(FILE_A)
          })?.last_seen_version ?? 0`,
        ),
      { timeout: 60_000 },
    ).toBeGreaterThan(0);
    await expect.poll(
      async () => {
        const arr = await pair.A.eval<Array<{ state: string }>>(`window.__geodeStates || []`);
        return arr.length ? arr[arr.length - 1].state : "";
      },
      { timeout: 30_000 },
    ).toBe("synced");

    /* --- 8. Read + log A's timeline --- */
    const timeline = await pair.A.eval<Array<{ state: string; tip: string; t: number }>>(
      `window.__geodeStates || []`,
    );
    const states = timeline.map((e) => e.state);
    console.log("DEVICE A STATUS BAR TIMELINE:", JSON.stringify(timeline));
    test.info().annotations.push({ type: "timeline", description: states.join(" -> ") });

    /* --- 9. Assertions (RED baseline: expected to fail against current code) --- */
    expect(states, "A must show amber dirty on its local edit").toContain("dirty");
    const firstDirty = states.indexOf("dirty");
    const pushingAfterDirty = states.indexOf("pushing", firstDirty + 1);
    expect(pushingAfterDirty, "A must eventually push its own edit").toBeGreaterThan(firstDirty);
    const between = states.slice(firstDirty + 1, pushingAfterDirty);
    /* THE BUG: a remote sync tick clobbered A's amber to the synced checkmark while A's edit was unpushed. */
    expect(
      between,
      "synced checkmark must not appear between A's dirty and A's pushing (remote-sync clobber bug)",
    ).not.toContain("synced");
  } finally {
    await pair.A.eval(
      `(() => { if (window.__geodeObs) window.__geodeObs.disconnect(); return true; })()`,
    ).catch(() => {});
    await pair.stop();
  }
});
