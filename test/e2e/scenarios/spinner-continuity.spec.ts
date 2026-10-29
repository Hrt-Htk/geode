import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { requireEnv } from "../env.ts";
import { waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitAckHoldExpired, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

/**
 * #523/#420: the status bar spinner must not restart or flash green:
 *
 * A. catch-up, while the apply backlog drains ("applying N/M"), the spinner's
 *    CSS animation runs continuously. Before the fix, every "applying" event
 *    re-rendered a fresh SVG and the animation restarted at 0° per file.
 *    Sampled transform angles must advance monotonically (no reset).
 *
 * B. upload: after the server acks a commit the green check holds ≥1 s even
 *    if a new save lands during the hold: no spin→green→spin flicker while
 *    typing, and no green between the flush and the ack.
 */

/** CSS matrix(a,b,c,d,e,f) → rotation in degrees [0, 360). */
function angleFromTransform(t: string): number | null {
  const m = t?.match(/matrix\(([^)]+)\)/);
  if (!m) return null;
  const [a, b] = m[1].split(",").map((s) => parseFloat(s.trim()));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return (deg + 360) % 360;
}

test("catch-up spinner rotates continuously, no per-file restart (#523)", async () => {
  test.slow();
  // A real vault (read-only) seeds enough files that the apply backlog outlasts setup.
  const seedDir = requireEnv("GEODE_SEED_VAULT_DIR");
  const server = await startServer();
  const seedDevice = await server.mintToken("seed");
  const seed = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: seedDevice.deviceId,
      deviceToken: seedDevice.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: "seed-pass",
    seedFiles: { sourceDir: seedDir, count: 300 },
  });
  let catcher: Awaited<ReturnType<typeof launchObsidian>> | null = null;
  try {
    await waitForUnlocked(seed);
    await waitForStatusBar(seed.win, "Geode: synced", 120_000);

    const device = await server.mintToken("catcher");
    catcher = await launchObsidian({
      geodeSettings: {
        serverUrl: server.url,
        vaultId: server.vaultId,
        deviceId: device.deviceId,
        deviceToken: device.token,
        salt: server.salt,
        debugLogging: true,
      },
      keepStartupModal: true,
    });

    // Sample the spinner's transform + title every 40 ms from BEFORE unlock
    // (the catch-up starts with the session and is short on desktop, so the
    // sampler must already be running), until the "applying" window has run
    // for 4 s. Element frames are captured in parallel.
    const sampler = catcher.win.evaluate(
      () =>
        new Promise<Array<{ t: number; title: string; transform: string }>>((resolve) => {
          const el = document.querySelector('[data-testid="geode-statusbar"]');
          const out: Array<{ t: number; title: string; transform: string }> = [];
          let applyingSince = -1;
          const start = performance.now();
          const timer = setInterval(() => {
            const now = performance.now();
            const svg = el.querySelector("svg");
            out.push({
              t: Math.round(now - start),
              title: el.title,
              transform: svg ? getComputedStyle(svg).transform : "",
            });
            if (el.title.includes("applying")) {
              if (applyingSince < 0) applyingSince = now;
              if (now - applyingSince > 4000) {
                clearInterval(timer);
                resolve(out);
              }
            } else if (applyingSince > 0) {
              clearInterval(timer);
              resolve(out);
            }
            if (now - start > 150_000) {
              clearInterval(timer);
              resolve(out);
            }
          }, 40);
        }),
    );

    const frames: string[] = [];
    const frameLoop = (async () => {
      for (let i = 0; i < 10; i++) {
        const title = await catcher.eval<string>(
          `document.querySelector('[data-testid="geode-statusbar"]')?.title ?? ""`,
        );
        if (title.includes("applying")) {
          const p = shotPath(`applying-frame-${i}.png`);
          await catcher
            .win.locator('[data-testid="geode-statusbar"]')
            .screenshot({ path: p })
            .catch(async () => {
              await catcher.win.screenshot({ path: p });
            });
          frames.push(p);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })();

    await catcher.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify("catcher-pass")});
      return true;
    `);

    const samples = await sampler;
    await frameLoop;

    const dir = path.dirname(shotPath("frame.png"));
    await writeFile(path.join(dir, "samples.json"), JSON.stringify(samples, null, 1));

    // The real drain on desktop finishes in well under a second, so the
    // animation-restart oracle drives the SAME per-file path the drain emits
    // (one updateSyncingProgress per file: exactly what the session does per
    // "applying" event) over a 4 s window and samples the spinner angle.
    const driven = catcher.win.evaluate(
      () =>
        new Promise<Array<{ t: number; transform: string }>>((resolve) => {
          const sb = app.plugins.plugins.geode.statusBar;
          const el = document.querySelector('[data-testid="geode-statusbar"]');
          const out: Array<{ t: number; transform: string }> = [];
          sb.updateState("live");
          const total = 200;
          let i = 0;
          const start = performance.now();
          const sample = setInterval(() => {
            const svg = el.querySelector("svg");
            out.push({
              t: Math.round(performance.now() - start),
              transform: svg ? getComputedStyle(svg).transform : "",
            });
          }, 20);
          const step = setInterval(() => {
            i++;
            if (i <= total) {
              sb.updateSyncingProgress(i, total);
            } else {
              clearInterval(step);
              clearInterval(sample);
              sb.clearSyncingProgress();
              resolve(out);
            }
          }, 20);
        }),
    );
    const drivenFrames: string[] = [];
    const drivenFrameLoop = (async () => {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const p = shotPath(`driven-frame-${i}.png`);
        await catcher
          .win.locator('[data-testid="geode-statusbar"]')
          .screenshot({ path: p })
          .catch(async () => {
            await catcher.win.screenshot({ path: p });
          });
        drivenFrames.push(p);
      }
    })();

    const drivenSamples = await driven;
    await drivenFrameLoop;
    await writeFile(path.join(dir, "driven-samples.json"), JSON.stringify(drivenSamples, null, 1));

    const angles = drivenSamples
      .map((s) => angleFromTransform(s.transform))
      .filter((a): a is number => a !== null);
    expect(angles.length, `need sampled angles, got ${JSON.stringify(drivenSamples.slice(0, 3))}`)
      .toBeGreaterThan(20);

    // A continuous 1 s/rotation sweep over 4 s passes every angle band; a
    // per-event restart keeps the angle pinned near 0° (max stays < ~15°).
    const maxAngle = Math.max(...angles);
    expect(
      maxAngle,
      `spinner never left the 0° band (max ${maxAngle.toFixed(1)}°): it restarts per event: ${
        JSON.stringify(angles.slice(0, 25))
      }`,
    ).toBeGreaterThan(300);

    // 20 ms of a 1 s/rotation animation is 7.2°; allow 45° per step. A
    // restart shows up as a large backward jump (e.g. 300° → 5°); the
    // legitimate 360°→0° wrap sits just under 360° and is not one.
    let restarts = 0;
    for (let i = 1; i < angles.length; i++) {
      if (angles[i] - angles[i - 1] < -45 && angles[i - 1] < 345) restarts++;
    }
    expect(
      restarts,
      `spinner restarted ${restarts}× during the applying window: ${
        JSON.stringify(angles.slice(0, 20))
      }`,
    ).toBe(0);
  } finally {
    await catcher?.close();
    await seed.close();
    await server.stop?.();
  }
});

test("green check holds ≥1 s after ack, no green before ack (#420)", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("flicker");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: "flicker-pass",
  });
  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    // #420: the startup config commits' ack holds the green check ~1 s; wait it
    // out so flicker-1 registers as dirty (not masked by the held checkmark).
    await waitAckHoldExpired(o.win);

    // Sample icon + title every 10 ms for 7 s while two saves land: one to
    // reach the ack, a second ~300 ms into the green to prove the hold.
    const sampler = o.win.evaluate(
      () =>
        new Promise<Array<{ t: number; icon: string; title: string }>>((resolve) => {
          const el = document.querySelector('[data-testid="geode-statusbar"]');
          const out: Array<{ t: number; icon: string; title: string }> = [];
          const start = performance.now();
          const timer = setInterval(() => {
            const svg = el.querySelector("svg");
            out.push({
              t: Math.round(performance.now() - start),
              icon: svg?.getAttribute("class") ?? "",
              title: el.title,
            });
            if (performance.now() - start > 7000) {
              clearInterval(timer);
              resolve(out);
            }
          }, 10);
        }),
    );

    await new Promise((r) => setTimeout(r, 500));
    // Create through the renderer so the real vault event fires (a raw fs
    // write depends on Obsidian's watcher debounce and can silently miss).
    await o.eval(`await app.vault.create("flicker-1.md", "first save"); return true;`);

    // Wait for the save to actually register (leave the initial synced state)
    // before looking for the ack: otherwise the poll races the vault event
    // and reads the stale green, mis-timing the second save.
    await expect
      .poll(
        async () => {
          const s = await readGeodeStatusBar(o.win);
          return s.includes("pending") ? "working" : s;
        },
        { timeout: 15_000 },
      )
      .toBe("working");

    // Wait for the ack: the green check after the "pushing" phase.
    await expect
      .poll(
        async () => {
          const s = await readGeodeStatusBar(o.win);
          const icon = await o.eval<string>(
            `document.querySelector('[data-testid="geode-statusbar"] svg')?.getAttribute("class") ?? ""`,
          );
          return s.includes("synced") && icon.includes("circle-check") ? "green" : s;
        },
        { timeout: 30_000 },
      )
      .toBe("green");

    // Second save lands while the green is (supposed to be) held.
    await new Promise((r) => setTimeout(r, 300));
    await o.eval(`await app.vault.create("flicker-2.md", "second save"); return true;`);

    // The second save must have registered (dirty count > 0) for the hold to mean anything.
    const dirtyAfterSecond = await o.eval<number>(
      `app.plugins.plugins.geode.statusBar.dirtyCount ?? 0`,
    );
    expect(dirtyAfterSecond, "second save never registered as dirty").toBeGreaterThan(0);

    const samples = await sampler;
    const dir = path.dirname(shotPath("frame.png"));
    await writeFile(path.join(dir, "flicker-samples.json"), JSON.stringify(samples, null, 1));

    // 1. No green between the flush ("pushing") and the ack: the first green
    //    after the pushing phase must not be preceded by a green in between.
    const firstPushing = samples.findIndex((s) => s.title.includes("pushing"));
    expect(firstPushing, "pushing phase never shown").toBeGreaterThan(-1);
    const firstGreen = samples.findIndex((s, i) =>
      i >= firstPushing && s.icon.includes("circle-check")
    );
    expect(firstGreen, "green check never appeared after pushing").toBeGreaterThan(-1);
    for (const s of samples.slice(firstPushing, firstGreen)) {
      expect(s.icon, `green before ack at t=${s.t}: ${JSON.stringify(s)}`).not.toContain(
        "circle-check",
      );
    }

    // 2. The green holds ≥1 s even though the second save landed during it.
    let greenUntil = firstGreen;
    for (let i = firstGreen + 1; i < samples.length; i++) {
      if (samples[i].icon.includes("circle-check")) greenUntil = i;
      else break;
    }
    const heldMs = samples[greenUntil].t - samples[firstGreen].t;
    expect(
      heldMs,
      `green held only ${heldMs} ms: ${JSON.stringify(samples.slice(firstGreen, firstGreen + 15))}`,
    ).toBeGreaterThanOrEqual(1000);

    // Capture the held-green state for the visual record.
    await o.eval(`app.setting?.close?.(); return true;`);
    await o.win.keyboard.press("Escape").catch(() => {});
    const el = o.win.locator('[data-testid="geode-statusbar"]');
    await el.screenshot({ path: shotPath("green-hold.png") }).catch(async () => {
      await o.win.screenshot({ path: shotPath("green-hold.png") });
    });
  } finally {
    await o.close();
    await server.stop?.();
  }
});
