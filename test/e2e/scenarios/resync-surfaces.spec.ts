import { expect, test } from "@playwright/test";
import { renameSync } from "node:fs";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import {
  confirmOpen,
  noticeTexts,
  resyncButtonText,
  seedResyncFiles,
  statusRowText,
  trackedCount,
} from "../helpers/resync";
import {
  openSettingsPage,
  scrollRowIntoView,
  scrollToHeading,
  useDisplayPath,
} from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";

// #54: the resync surfaces in real Obsidian: the confirm dialog, one notice that moves
// while the rebuild runs, the settings row at each stage, and the stop that keeps its
// reason. Drives the real button path; no state is injected.
const PASSPHRASE = "resync-surfaces-passphrase";
const NOTES = 120;
/** One large file keeps the rebuild busy for seconds: a test vault of notes alone
 * rebuilds in a few hundred milliseconds, too short to photograph. */
const LARGE = 128 * 1024 * 1024;

type Obsidian = Awaited<ReturnType<typeof launchObsidian>>;

test("resync surfaces: confirm, running, done, stopped", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("resync-surfaces");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await seedResyncFiles(o, { notes: NOTES, largeBytes: LARGE });
    // The vault carries a few files of its own besides the seeds.
    await expect.poll(async () => await trackedCount(o), { timeout: 300_000 })
      .toBeGreaterThanOrEqual(NOTES + 1);
    // The large file is what makes the rebuild last, and it must be ON THE SERVER before the
    // resync starts: a head the run never sees rebuilds in a blink. The row's version is
    // stamped when the commit acks, so this waits for the upload, not just for the file.
    await expect.poll(
      async () =>
        await o.eval<number>(`
          app.plugins.plugins.geode.syncManager?.state?.getLocalFile("media/large.bin")
            ?.last_seen_version ?? 0
        `),
      { timeout: 120_000 },
    ).toBeGreaterThan(0);
    await waitForStatusBar(o.win, "Geode: synced", 300_000);

    // The display() path keeps Status and Advanced rows in one pane, the way the mockup
    // laid them out (1.13+ puts Advanced on its own page).
    await o.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await useDisplayPath(o);
    await openSettingsPage(o, "Advanced");
    await scrollRowIntoView(o, "Resync from scratch");
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 })
      .toBe("Resync from scratch");

    // Record what the run publishes, so the re-entrancy check can prove it never restarted.
    await o.eval(`
      window.__geodeResyncStates = [];
      const bar = app.plugins.plugins.geode.statusBar;
      const publish = bar.setResync.bind(bar);
      bar.setResync = (state) => {
        window.__geodeResyncStates.push(state);
        publish(state);
      };
      return true;
    `);

    /* ---- Confirm ---- */
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-resync"]').click(); return true;`,
    );
    await expect.poll(async () => await confirmOpen(o), { timeout: 10_000 }).toBe(true);
    await shoot(o, "1-confirm-desktop");

    /* ---- Running: one notice that moves, the row and the bar following it ---- */
    await o.eval(
      `document.querySelector('[data-testid="geode-confirm-yes"]').click(); return true;`,
    );
    // #54 review: the palette is not disabled while a run is going. It must join the run,
    // not fail and not start a second rebuild.
    await o.eval(`app.commands.executeCommandById("geode:resync"); return true;`);
    // One running frame: a desktop rebuild of a test vault can finish in a second, and the
    // phone spec carries the second (Advanced row) running shot. The busy button is asserted
    // here instead, in the same bracketed window.
    await shootWhileRunning(o, "2-running-desktop", async () => {
      await scrollToHeading(o, "Sync status");
    });
    expect(await resyncButtonText(o)).toBe("Resyncing…");

    /* ---- Done ---- */
    await expect.poll(async () => await statusRowText(o), { timeout: 300_000 }).toContain(
      "Up to date",
    );
    const states = await o.eval<Array<{ phase: string; progress?: { current: number } } | null>>(
      "return window.__geodeResyncStates;",
    );
    const counts = states
      .filter((state) => state?.phase === "running")
      .map((state) => state!.progress!.current);
    // One run: a single uncounted start, and the counts only move forward.
    expect(counts.filter((current) => current === 0)).toHaveLength(1);
    for (let index = 1; index < counts.length; index++) {
      expect(counts[index], "progress never restarts").toBeGreaterThanOrEqual(counts[index - 1]);
    }
    // Progress moves: at least one published count sits strictly between the start and the
    // total (the counts themselves are throttled, see RESYNC_RENDER_MS).
    expect(counts.some((current) => current > 0 && current < counts.at(-1)!)).toBe(true);
    expect(
      await o.eval<string[]>(`app.plugins.plugins.geode.getRecentLog()
        .filter((e) => e.level === "error" && e.msg === "resync command failed")
        .map((e) => e.msg)`),
    ).toEqual([]);

    await scrollRowIntoView(o, "Resync from scratch");
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 })
      .toBe("Resync from scratch");
    await shoot(o, "3-done-resync-row-desktop");
    await scrollToHeading(o, "Sync status");
    await shoot(o, "4-done-status-row-desktop");

    /* ---- Stopped by an outage: the rebuilt session comes back and retries ---- */
    // The done notice fades like any other: wait it out so the stop notice stands alone.
    await expect.poll(
      async () => await o.eval<number>(`document.querySelectorAll(".notice").length`),
      { timeout: 20_000 },
    ).toBe(0);
    await server.shutdown();
    await scrollRowIntoView(o, "Resync from scratch");
    await clickResync(o);
    // #54 review: the restart brought a session back that is now offline, and that outage
    // outranks the stopped row; the notice carries the reason and the button the retry.
    await expect.poll(async () => await noticeTexts(o), { timeout: 120_000 }).toContain(
      "Geode: resync stopped. Server unreachable.",
    );
    await expect.poll(async () => await statusRowText(o), { timeout: 10_000 }).toContain(
      "Offline. Retrying",
    );
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 }).toBe("Try again");
    await scrollToHeading(o, "Sync status");
    await shoot(o, "5-stopped-status-row-desktop");
    await scrollRowIntoView(o, "Resync from scratch");
    await shoot(o, "6-stopped-resync-row-desktop");

    /* ---- Try again against a healthy server: the retry runs and sync comes back ---- */
    await server.restart();
    await clickResync(o);
    await expect.poll(async () => await statusRowText(o), { timeout: 120_000 }).toContain(
      "Up to date",
    );
    expect(
      await o.eval<boolean>("!!app.plugins.plugins.geode.transport"),
      "the retry leaves a live session behind",
    ).toBe(true);
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 })
      .toBe("Resync from scratch");
    await scrollToHeading(o, "Sync status");
    await shoot(o, "7-retried-status-row-desktop");

    /* ---- A crash-style stop: the marker survives a plugin reload (M2) ---- */
    // Pause first: the session must not commit the delete of the file we lose next, and a
    // paused vault keeps everything on this device. Then the plugin is off, so removing the
    // file leaves no event behind, and the server loses the head's chunks: the rebuild
    // restores the other files and cannot restore this one.
    const lost = "notes/note-0000.md";
    const chunks = await o.eval<string[]>(`
      app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${JSON.stringify(lost)})
        ?.chunk_hashes ?? []
    `);
    expect(chunks.length, "the lost file has chunks").toBeGreaterThan(0);
    await o.eval(`await app.plugins.plugins.geode.pauseSync(); return true;`);
    await o.eval(`app.plugins.disablePlugin("geode"); return true;`);
    await o.eval(`await app.vault.adapter.remove(${JSON.stringify(lost)}); return true;`);
    const hidden = hideBlobs(server, chunks);
    await o.eval(`await app.plugins.enablePlugin("geode"); return true;`);
    await waitForUnlocked(o);
    await o.eval(`app.commands.executeCommandById("geode:resync"); return true;`);
    await expect.poll(
      async () => (await noticeTexts(o)).some((text) => text.startsWith("Geode: resync stopped.")),
      { timeout: 120_000 },
    ).toBe(true);
    expect(
      await o.eval<string>("app.plugins.plugins.geode.pluginSettings.resyncStop"),
      "the partial failure persisted a marker",
    ).not.toBe("");

    // The reload: a fresh plugin against the persisted settings. The marker keeps every
    // session start off the rows the failed rebuild left, and the stop is what comes up.
    await o.eval(`app.plugins.disablePlugin("geode"); return true;`);
    await o.eval(`await app.plugins.enablePlugin("geode"); return true;`);
    await waitForUnlocked(o);
    await o.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    await expect.poll(async () => await statusRowText(o), { timeout: 30_000 }).toContain(
      "Resync stopped.",
    );
    expect(
      await o.eval<boolean>("!!app.plugins.plugins.geode.transport"),
      "the marker starts no session on the reload",
    ).toBe(false);
    await shoot(o, "8-reloaded-stopped-desktop");

    // Try again (the palette runs the same method as the button): with the chunks back it
    // completes, clears the marker, and sync resumes where the pause left it.
    restoreBlobs(hidden);
    await o.eval(`app.commands.executeCommandById("geode:resync"); return true;`);
    await expect.poll(
      async () => await o.eval<string>("app.plugins.plugins.geode.pluginSettings.resyncStop"),
      { timeout: 120_000 },
    ).toBe("");
    await o.eval(`await app.plugins.plugins.geode.resumeSync(); return true;`);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await expect.poll(async () => await statusRowText(o), { timeout: 30_000 }).toContain(
      "Up to date",
    );
    await shoot(o, "9-marker-recovered-desktop");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

/** Move the given chunk blobs aside: the server can no longer serve that head. */
function hideBlobs(
  server: Awaited<ReturnType<typeof startServer>>,
  hashes: string[],
): string[] {
  return hashes.map((hash) => {
    const blob = `${server.dataDir}/blobs/${server.vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`;
    renameSync(blob, `${blob}.away`);
    return `${blob}.away`;
  });
}

function restoreBlobs(hidden: string[]): void {
  for (const aside of hidden) renameSync(aside, aside.replace(/\.away$/, ""));
}

async function clickResync(o: Obsidian): Promise<void> {
  await o.eval(
    `document.querySelector('[data-testid="geode-settings-resync"]').click(); return true;`,
  );
  await expect.poll(async () => await confirmOpen(o), { timeout: 10_000 }).toBe(true);
  await o.eval(`document.querySelector('[data-testid="geode-confirm-yes"]').click(); return true;`);
}

async function shoot(o: Obsidian, name: string): Promise<void> {
  await o.win.screenshot({ path: shotPath(name) });
}

/** Bracket a shot with the live row: the frame is a running frame only when the row still
 * says resyncing after the screenshot resolved. */
async function shootWhileRunning(
  o: Obsidian,
  name: string,
  position: () => Promise<void>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await resyncRunning(o))) continue;
    await position();
    if (!(await resyncRunning(o))) continue;
    await shoot(o, name);
    if (await resyncRunning(o)) return;
  }
  throw new Error(
    `resync finished before the "${name}" shot (row: "${await statusRowText(o)}", ` +
      `button: "${await resyncButtonText(o)}")`,
  );
}

/** A counted running state: the shots show the progress, not the interim before the list. */
function resyncRunning(o: Obsidian): Promise<boolean> {
  return o.eval<boolean>(`
    (() => {
      const row = document.querySelector('[data-testid="geode-settings-sync-status"]');
      const text = row?.querySelector(".setting-item-description")?.textContent ?? "";
      return /^Resyncing: \\d+ of \\d+ files\\.$/.test(text.trim());
    })()
  `);
}
