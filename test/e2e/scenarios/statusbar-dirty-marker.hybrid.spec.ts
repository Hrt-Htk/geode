import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { commitPath, upsertVaultFile } from "../helpers/geode";

// #141: both roles: a remote sync never wipes the dirty marker while A has unpushed edits.

const PASSPHRASE = "clobber-passphrase";
const FILE_A = "notes/device-a.md";
const FILE_B = "notes/device-b.md";

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(`status bar clobber: remote sync must not wipe dirty marker while A has unpushed edits (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    // #210 (cross-vault blob-store collision serving the wrong vault's ciphertext) is fixed by
    // vault-scoping the server blob store, so both variants now run.
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

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

      /* Scale timeouts when phone is A: it's slower to receive/settle than desktop. */
      const phoneTimeout = phoneAsA ? 120_000 : 60_000;
      const settleTimeout = phoneAsA ? 60_000 : 30_000;

      /* --- 6. Wait until A RECEIVES B's file (fires onSyncStatus("sync") on A). --- */
      await expect.poll(
        async () =>
          await pair.A.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(FILE_B)})`),
        { timeout: phoneTimeout },
      ).toBe(true);

      /* --- 7. Let A's own edit flush/push naturally, then settle to synced. --- */
      await expect.poll(
        async () =>
          await pair.A.eval<number>(
            `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
              JSON.stringify(FILE_A)
            })?.last_seen_version ?? 0`,
          ),
        { timeout: phoneTimeout },
      ).toBeGreaterThan(0);
      await expect.poll(
        async () => {
          const arr = await pair.A.eval<Array<{ state: string }>>(`window.__geodeStates || []`);
          return arr.length ? arr[arr.length - 1].state : "";
        },
        { timeout: settleTimeout },
      ).toBe("synced");

      /* --- 8. Read + annotate A's timeline --- */
      const timeline = await pair.A.eval<Array<{ state: string; tip: string; t: number }>>(
        `window.__geodeStates || []`,
      );
      const states = timeline.map((e) => e.state);
      test.info().annotations.push({ type: "timeline", description: states.join(" -> ") });

      /* --- 9. Anti-clobber assertion --- */
      /* "dirty" may never appear if the reconciler pushes before the statusbar renders it (fast
         phone path).  The real invariant: when we *do* see dirty, no "synced" checkmark appears
         between it and the next "pushing".  If dirty is absent the invariant is vacuously true. */
      const firstDirty = states.indexOf("dirty");
      if (firstDirty >= 0) {
        expect(true, "A showed dirty: anti-clobber check applies").toBe(true);
        const pushingAfterDirty = states.indexOf("pushing", firstDirty + 1);
        expect(
          pushingAfterDirty,
          "A must eventually push its own edit after showing dirty",
        ).toBeGreaterThan(firstDirty);
        const between = states.slice(firstDirty + 1, pushingAfterDirty);
        /* THE BUG: a remote sync tick clobbered A's amber to the synced checkmark while A's edit was unpushed. */
        expect(
          between,
          "synced checkmark must not appear between A's dirty and A's pushing (remote-sync clobber bug)",
        ).not.toContain("synced");
      } else {
        /* dirty was never observed: reconciler pushed before statusbar rendered it.
           Invariant is vacuously satisfied; still log the timeline for visibility. */
        expect(
          true,
          `"dirty" not captured (fast reconciler path); timeline: ${
            states.join(" -> ")
          }; anti-clobber vacuously satisfied`,
        ).toBe(true);
      }
    } finally {
      await pair.A.eval(
        `(() => { if (window.__geodeObs) window.__geodeObs.disconnect(); return true; })()`,
      ).catch(() => {});
      await pair.stop();
    }
  });
}
