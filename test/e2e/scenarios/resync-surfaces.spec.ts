import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import {
  openSettingsPage,
  scrollRowIntoView,
  scrollToHeading,
  useDisplayPath,
} from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";

// #54: the resync surfaces in real Obsidian: the confirm dialog, one notice that moves
// while the rebuild runs, the settings row at each stage, and the stop that keeps its
// reason. Drives the real button path; no state is injected.
const PASSPHRASE = "resync-surfaces-passphrase";
const NOTES = 120;
/** One large file keeps the rebuild busy for seconds: a test vault of notes alone
 * rebuilds in a few hundred milliseconds, too short to photograph. */
const LARGE = 128 * 1024 * 1024;

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
    await seed(o);
    // The vault carries a few files of its own besides the seeds.
    await expect.poll(async () => await trackedCount(o), { timeout: 300_000 })
      .toBeGreaterThanOrEqual(NOTES + 1);
    await waitForStatusBar(o.win, "Geode: synced", 300_000);

    // The display() path keeps Status and Advanced Rows in one pane, the way the mockup
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
    await shootWhileRunning(o, "2-running-status-row-desktop", async () => {
      await scrollToHeading(o, "Sync status");
    });
    await shootWhileRunning(o, "3-running-resync-row-desktop", async () => {
      await scrollRowIntoView(o, "Resync from scratch");
    });

    /* ---- Done ---- */
    await expect.poll(async () => await statusRowText(o), { timeout: 300_000 }).toContain(
      "Up to date",
    );
    await scrollRowIntoView(o, "Resync from scratch");
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 })
      .toBe("Resync from scratch");
    await shoot(o, "4-done-resync-row-desktop");
    await scrollToHeading(o, "Sync status");
    await shoot(o, "5-done-status-row-desktop");

    /* ---- Stopped: the server goes away before the run, so the run stops at once ---- */
    // The done notice fades like any other: wait it out so the stop notice stands alone.
    await expect.poll(
      async () => await o.eval<number>(`document.querySelectorAll(".notice").length`),
      { timeout: 20_000 },
    ).toBe(0);
    await server.stop();
    await scrollRowIntoView(o, "Resync from scratch");
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-resync"]').click(); return true;`,
    );
    await expect.poll(async () => await confirmOpen(o), { timeout: 10_000 }).toBe(true);
    await o.eval(
      `document.querySelector('[data-testid="geode-confirm-yes"]').click(); return true;`,
    );
    await expect.poll(async () => await statusRowText(o), { timeout: 120_000 }).toContain(
      "Resync stopped",
    );
    // Shoot at once: the stop notice fades like any other, the row keeps the reason.
    await expect.poll(async () => await resyncButtonText(o), { timeout: 10_000 }).toBe("Try again");
    await shoot(o, "6-stopped-resync-row-desktop");
    await scrollToHeading(o, "Sync status");
    await shoot(o, "7-stopped-status-row-desktop");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

async function shoot(
  o: Awaited<ReturnType<typeof launchObsidian>>,
  name: string,
): Promise<void> {
  await o.win.screenshot({ path: shotPath(name) });
}

/** Bracket a shot with the live row: the frame is a running frame only when the row still
 * says resyncing after the screenshot resolved. */
async function shootWhileRunning(
  o: Awaited<ReturnType<typeof launchObsidian>>,
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
  throw new Error(`resync finished before the "${name}" shot`);
}

function resyncRunning(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<boolean> {
  return o.eval<boolean>(`
    (() => {
      const row = document.querySelector('[data-testid="geode-settings-sync-status"]');
      const text = row?.querySelector(".setting-item-description")?.textContent ?? "";
      return text.trim().startsWith("Resyncing");
    })()
  `);
}

function statusRowText(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<string> {
  return o.eval<string>(`
    (() => {
      const row = document.querySelector('[data-testid="geode-settings-sync-status"]');
      return row?.querySelector(".setting-item-description")?.textContent?.trim() ?? "";
    })()
  `);
}

function resyncButtonText(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<string> {
  return o.eval<string>(`
    (() => {
      const btn = document.querySelector('[data-testid="geode-settings-resync"]');
      return btn?.textContent?.trim() ?? "";
    })()
  `);
}

function confirmOpen(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<boolean> {
  return o.eval<boolean>(`!!document.querySelector(".geode-confirm-modal")`);
}

function trackedCount(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<number> {
  return o.eval<number>(`
    (() => {
      const state = app.plugins.plugins.geode.syncManager?.state;
      return state ? [...state.getAllLocalFiles().values()].filter((r) => !r.deleted).length : 0;
    })()
  `);
}

/** Unique bytes per file, so nothing dedupes away: the rebuild has real work to do. */
async function seed(o: Awaited<ReturnType<typeof launchObsidian>>): Promise<void> {
  await o.eval(`
    const files = [];
    for (let index = 0; index < ${NOTES}; index++) {
      files.push({ path: "notes/note-" + String(index).padStart(4, "0") + ".md", size: 900 + index });
    }
    const large = new Uint8Array(${LARGE});
    for (let offset = 0; offset < large.length; offset += 65536) {
      crypto.getRandomValues(large.subarray(offset, offset + 65536));
    }
    if (!(await app.vault.adapter.exists("media"))) await app.vault.createFolder("media");
    await app.vault.createBinary("media/large.bin", large.buffer);
    for (const [index, file] of files.entries()) {
      let state = 7919 + index * 104729;
      const bytes = new Uint8Array(file.size);
      for (let i = 0; i < bytes.length; i++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        bytes[i] = state & 0xff;
      }
      const slash = file.path.lastIndexOf("/");
      const folder = file.path.slice(0, slash);
      if (!(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
      await app.vault.createBinary(file.path, bytes.buffer);
    }
    await app.plugins.plugins.geode.syncManager.handlePendingOps([
      ...files.map((file) => ({ path: file.path, kind: "commit" })),
      { path: "media/large.bin", kind: "commit" },
    ]);
    return true;
  `);
}
