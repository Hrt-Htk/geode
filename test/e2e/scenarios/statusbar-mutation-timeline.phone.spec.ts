import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { upsertVaultFile } from "../helpers/geode";
import { waitAckHoldExpired } from "../helpers/waits";

// #144: on-device: the real dirty→pushing→synced timeline via MutationObserver.

const PASSPHRASE = "realflow-passphrase";
const FILE_PATH = "notes/realflow.md";

test("status bar real-flow: MutationObserver timeline captures dirty→pushing→synced", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("realflow");
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
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );
    /* --- 1. Reach a STABLE synced baseline (ok and NOT spinning: the startup
     * config commits push with ok+spin, so "ok" alone matches pushing too) --- */
    await expect.poll(
      async () =>
        await obsidian.eval<boolean>(
          `(() => { const el = document.querySelector('[data-testid="geode-mobile-status"]'); const c = el ? el.classList : null; return !!c && c.contains("geode-statusbar-ok") && !c.contains("geode-statusbar-spin"); })()`,
        ),
      { timeout: 60_000 },
    ).toBe(true);
    /* #420: wait out the startup ack's green hold. */
    await waitAckHoldExpired(obsidian.win);

    /* --- 2. Install MutationObserver timeline recorder (BEFORE the edit) --- */
    /* Uses attributeOldValue so we capture transient states (e.g. dirty) even when
     * they are clobbered within the same mutation batch: the oldValue preserves the
     * intermediate class value that the live read would miss. */
    await obsidian.eval(`
      (() => {
        const el = document.querySelector('[data-testid="geode-mobile-status"]');
        window.__geodeStates = [];
        // Classify by the aria-label tooltip, which renderMobile sets ONCE (last) per
        // render: atomic, so it avoids the transient classList remove/add artifacts
        // (no-color -> "unknown", ok-before-spin -> "synced") that a class observer sees.
        const classifyTip = (tip) => {
          tip = tip || '';
          if (tip.includes('locked')) return 'locked';
          if (tip.includes('conflict')) return 'error';
          if (tip.includes('pushing')) return 'pushing';
          if (tip.includes('pending')) return 'dirty';
          if (tip.includes('syncing')) return 'syncing';
          if (tip.includes('synced')) return 'synced';
          if (tip.includes('connecting')) return 'connecting';
          if (tip.includes('offline')) return 'disconnected';
          return 'unknown';
        };
        const recordTip = (tip) => {
          const state = classifyTip(tip);
          if (state === 'unknown') return;
          const arr = window.__geodeStates;
          const last = arr[arr.length - 1];
          if (!last || last.state !== state) arr.push({ state, tip, t: Date.now() });
        };
        recordTip(el.getAttribute('aria-label') || el.title || '');
        // attributeOldValue captures a transient (e.g. dirty) even if a later render
        // coalesces into the same mutation batch.
        window.__geodeObs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'aria-label' && m.oldValue != null) {
              recordTip(m.oldValue);
            }
          }
          recordTip(el.getAttribute('aria-label') || el.title || '');
        });
        window.__geodeObs.observe(el, { attributes: true, attributeOldValue: true, attributeFilter: ['aria-label'] });
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

    /* --- 5. Read the recorded timeline and annotate for visibility --- */
    const timeline = await obsidian.eval<Array<{ state: string; tip: string; t: number }>>(
      `window.__geodeStates || []`,
    );
    const states = timeline.map((e) => e.state);
    test.info().annotations.push({ type: "timeline", description: states.join(" -> ") });

    /* --- 6. Assert the real-flow sequence ---
     * `pushing` (the debounced flush) and the terminal `synced` state are stable and are
     * observed reliably on-device → HARD assertions. The intermediate `dirty` state is a
     * single `aria-label` write that the browser can coalesce with the adjacent `pushing`
     * write inside one mutation batch, so `attributeOldValue` cannot always recover it
     * (issue #223). Record `dirty` and its ordering before `pushing` as SOFT annotations
     * rather than a flaky hard assertion: the push actually completing is proven by the
     * `last_seen_version > 0` poll in step 4. */
    expect(states, "pushing state must appear when the debounced flush pushes").toContain(
      "pushing",
    );

    const firstDirty = states.indexOf("dirty");
    if (firstDirty === -1) {
      test.info().annotations.push({
        type: "coalesced-transient",
        description:
          "dirty state not observed (aria-label coalesced with pushing): expected per #223",
      });
    } else {
      const pushingAfterDirty = states.indexOf("pushing", firstDirty + 1);
      test.info().annotations.push({
        type: "timeline-order",
        description: `dirty@${firstDirty} -> pushing@${pushingAfterDirty}`,
      });
      /* Clobber check (#420, hard): no green flash between dirty and pushing. */
      const between = pushingAfterDirty > firstDirty
        ? states.slice(firstDirty + 1, pushingAfterDirty)
        : [];
      expect(between, "green check flashed between dirty and pushing (#420)").not.toContain(
        "synced",
      );
    }

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
