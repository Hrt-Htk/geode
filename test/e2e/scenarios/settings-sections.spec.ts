import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #134: the settings tab is a set of collapsible sections. This gate locks in the
// section order/render model, the live sync-status + trash-count rows, the no-full-re-render
// property (rename / lock / unlock / sync-config toggle / status changes update rows in place),
// last-backup persistence, and three screenshots of the real tab.
const PASSPHRASE = "settings-sections-pass";

const SECTION_ORDER = ["Status", "Vault", "Devices", "Sync scope", "Trash", "Advanced"];

/** Scroll whichever settings pane element is actually scrollable to a small non-zero offset. */
async function scrollSettings(
  o: { eval: <T>(s: string) => Promise<T> },
  to: number,
): Promise<number> {
  return await o.eval<number>(`
    (() => {
      const candidates = [".vertical-tab-content", ".modal.mod-settings .modal-content"];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollTop = ${to};
          if (el.scrollTop > 0) return el.scrollTop;
        }
      }
      return 0;
    })()
  `);
}

async function readScroll(o: { eval: <T>(s: string) => Promise<T> }): Promise<number> {
  return await o.eval<number>(`
    (() => {
      const candidates = [".vertical-tab-content", ".modal.mod-settings .modal-content"];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.scrollTop > 0) return el.scrollTop;
      }
      return 0;
    })()
  `);
}

/**
 * Toggle a settings checkbox without the native click's focus-scroll. A raw
 * el.click() on the input focuses it and Chromium scrolls it into view, moving
 * the pane's scrollTop without any re-render. Set checked and dispatch the
 * change event instead: Obsidian's Toggle onChange listens on "change", so
 * the real handler runs with no focus/scroll side effect.
 */
async function toggleCheckbox(
  o: { eval: <T>(s: string) => Promise<T> },
  sel: string,
): Promise<void> {
  await o.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error("toggleCheckbox: no element for " + ${JSON.stringify(sel)});
      el.checked = !el.checked;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

/**
 * Click a settings button without the native focus-scroll: dispatch an untrusted
 * click event. The click listener still fires, but untrusted events skip the
 * focus default action, so the pane's scrollTop is untouched.
 */
async function clickButton(o: { eval: <T>(s: string) => Promise<T> }, sel: string): Promise<void> {
  await o.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error("clickButton: no element for " + ${JSON.stringify(sel)});
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    })()
  `);
}

test("settings sections: order, live rows, no full re-render, last-backup persistence", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("settings-sections");
  const o = await launchObsidian({
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
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* Known toggle state before the settings tab renders: plugin list OFF (so the
       on/off toggle test below starts from a deterministic state). */
    await o.eval(`app.plugins.plugins.geode.settings.syncObsidianConfig = false; return true;`);

    /* Open the settings tab and keep it open for every screenshot (never close it). */
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    await o.win.locator('[data-testid="geode-settings-sync-status"]').waitFor({ timeout: 15_000 });

    /* ---- 1. Sections render in order; Advanced collapsed by default, others open ---- */
    const headings = (await o.win
      .locator(".vertical-tab-content .geode-section .setting-item-heading")
      .allTextContents()).map((h) => h.trim());
    expect(headings, "section order").toEqual(SECTION_ORDER);
    await expect(o.win.locator(".geode-advanced-fields.geode-collapsed")).toHaveCount(1);
    await expect(o.win.locator(".geode-section-fields:not(.geode-collapsed)")).toHaveCount(5);

    /* ---- 2. Sync status row: "Up to date. Last backup …" with the green dot ---- */
    const syncStatusRow = o.win.locator('[data-testid="geode-settings-sync-status"]');
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 60_000 },
    ).toMatch(/^Up to date\. Last backup (just now|\d+ min ago)\.$/);
    await expect(syncStatusRow.locator(".geode-sync-dot-green")).toBeVisible();

    /* ---- 3. Trash count row settles off "Checking trash…" ---- */
    const trashCountRow = o.win.locator('[data-testid="geode-settings-trash-count"]');
    await expect.poll(
      async () => await trashCountRow.locator(".setting-item-description").textContent(),
      { timeout: 15_000 },
    ).toMatch(/^(Trash is empty|1 file in trash|\d+ files in trash)$/);

    /* ---- Screenshot 1: top of the tab, everything expanded ---- */
    await scrollSettings(o, 0);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("134-01-unlocked-top.png"),
    });

    /* ---- 4. No full re-render across in-place updates ---- */
    // Collapse Devices, then mark its .geode-section element: display() would recreate it.
    await o.win
      .locator(
        '.geode-section:has(.setting-item-heading:has-text("Devices")) .geode-collapsible-heading',
      )
      .click();
    await o.eval(`
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const dev = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Devices"));
      if (!dev) throw new Error("Devices section not found");
      dev.dataset.e2eMarker = "no-rerender";
      return true;
    `);
    const scrolled = await scrollSettings(o, 120);
    expect(scrolled, "settings pane should be scrollable to a non-zero offset").toBeGreaterThan(0);

    const markerPresent = (): Promise<boolean> =>
      o.eval<boolean>(
        `!!document.querySelector('.geode-section[data-e2e-marker="no-rerender"]')`,
      );
    const devicesStillCollapsed = (): Promise<boolean> =>
      o.eval<boolean>(`
      (() => {
        const sections = Array.from(document.querySelectorAll(".geode-section"));
        const dev = sections.find((s) => s.querySelector(".setting-item-heading")?.textContent?.includes("Devices"));
        return !!dev && !!dev.querySelector(".geode-section-fields")?.classList.contains("geode-collapsed");
      })()
    `);

    const assertNoRerender = async (label: string, before: number): Promise<number> => {
      await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
      expect(await devicesStillCollapsed(), `${label}: Devices stays collapsed`).toBe(true);
      const after = await readScroll(o);
      expect(Math.abs(after - before), `${label}: scrollTop unchanged ±1`).toBeLessThanOrEqual(1);
      return after;
    };

    // 4a. Status change (syncing → live) updates the row text in place.
    const beforeScroll = await readScroll(o);
    await o.eval(`app.plugins.plugins.geode.statusBar.updateState("syncing"); return true;`);
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Catching up/);
    await o.eval(`app.plugins.plugins.geode.statusBar.updateState("live"); return true;`);
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Up to date\. Last backup /);
    await assertNoRerender("status change", beforeScroll);

    // 4b. Sync config toggle on+off shows/hides the Config to sync row in place, not a tab re-render.
    // toggleCheckbox: a raw el.click() on the checkbox input focuses it, and Chromium's
    // focus scroll-into-view moves the pane; dispatching change runs the same handler.
    const syncToggleSel = '[data-testid="geode-settings-toggle-sync-obsidian"]';
    const scrollAfterToggle = await readScroll(o);
    await toggleCheckbox(o, syncToggleSel);
    await o.win.locator('[data-testid="geode-settings-config-row"]').waitFor({ timeout: 10_000 });
    await assertNoRerender("sync toggle on", scrollAfterToggle);
    await toggleCheckbox(o, syncToggleSel);
    await expect(o.win.locator('[data-testid="geode-settings-config-row"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    await assertNoRerender("sync toggle off", await readScroll(o));

    // 4c. Rename updates the vault row desc in place.
    await o.eval(`app.plugins.plugins.geode.onVaultNameResolved("renamed"); return true;`);
    const vaultNameRow = o.win.locator('[data-testid="geode-settings-vault-name"]');
    await expect.poll(
      async () => await vaultNameRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toMatch(/^renamed · /);
    await assertNoRerender("rename", await readScroll(o));

    // 4d. Lock (in place): Devices/Trash hide, status row turns locked. Hiding whole
    // sections collapses content, so scrollTop clamps by layout (not a re-render); the
    // marker + Devices-stays-collapsed checks are the no-re-render proof on lock.
    await clickButton(o, '[data-testid="geode-settings-lock"]');
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 10_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
    await expect(
      o.win.locator(".geode-section:has(.setting-item-heading:has-text('Devices'))"),
    ).toHaveClass(/geode-hidden/);
    await expect(
      o.win.locator(".geode-section:has(.setting-item-heading:has-text('Trash'))"),
    ).toHaveClass(/geode-hidden/);
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    expect(await devicesStillCollapsed(), "lock: Devices stays collapsed").toBe(true);

    // 4e. Unlock via the real UI path (passphrase modal → plugin unlock → onUnlocked).
    await clickButton(o, '[data-testid="geode-settings-unlock"]');
    const passModal = o.win.locator('.modal:has(:text("Unlock Geode"))');
    await expect(passModal).toBeVisible({ timeout: 10_000 });
    await passModal.locator('[data-testid="geode-passphrase-input"]').fill(PASSPHRASE);
    await passModal.locator('[data-testid="geode-passphrase-input"]').press("Enter");
    await expect(passModal).not.toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          await o.win
            .locator('[data-testid="geode-settings-vault-status"] .setting-item-description')
            .textContent(),
        { timeout: 15_000 },
      )
      .toMatch(/^Unlocked\. /);
    await expect(
      o.win.locator(".geode-section:has(.setting-item-heading:has-text('Devices'))"),
    ).not.toHaveClass(/geode-hidden/);
    await assertNoRerender("unlock", await readScroll(o));

    /* ---- Screenshot 2: Advanced expanded, scrolled to it (still unlocked) ---- */
    await o.win.locator(".geode-advanced-heading").click();
    await o.eval(`
      const heading = Array.from(document.querySelectorAll(".geode-advanced-heading"))
        .find((h) => h.classList.contains("geode-collapsible-heading"));
      if (heading) heading.scrollIntoView({ block: "start" });
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("134-02-advanced-open.png"),
    });

    /* ---- 5. Last-backup persistence: sync-cursor.json carries a numeric last_backup_at > 0 ---- */
    const cursorPath = path.join(o.vaultDir, ".obsidian", "plugins", "geode", "sync-cursor.json");
    await expect.poll(async () => {
      try {
        const raw = await readFile(cursorPath, "utf8");
        const obj = JSON.parse(raw) as { last_backup_at?: unknown };
        return typeof obj.last_backup_at === "number" && obj.last_backup_at > 0
          ? obj.last_backup_at
          : null;
      } catch {
        return null;
      }
    }, { timeout: 90_000 }).toBeGreaterThan(0);

    // The fixture cannot relaunch Obsidian on the same vault dir (fresh temp vault per launch),
    // so the "relaunch locked" text is verified in place: lock again and read the status row,
    // it must show the persisted backup stamp, NOT "Not backed up yet.".
    await o.eval(
      `document.querySelector('[data-testid="geode-settings-lock"]').click(); return true;`,
    );
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 15_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
    const lockedText = (await syncStatusRow.locator(".setting-item-description").textContent()) ??
      "";
    expect(lockedText).not.toContain("Not backed up yet.");

    /* ---- Screenshot 3: locked state: scroll back to top so the locked rows show ---- */
    await scrollSettings(o, 0);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("134-03-locked.png"),
    });

    // Sanity: every section is still accounted for (no stray re-render duplicates).
    expect(await o.win.locator(".vertical-tab-content .geode-section").count()).toBe(6);

    /* ---- 5b. Cold plugin reload while locked: onload re-reads last_backup_at from disk ---- */
    // Lock cleared the key cache, so the reloaded plugin stays locked and its stamp
    // can only come from sync-cursor.json.
    await o.eval(`
      app.setting.close();
      await app.plugins.disablePlugin("geode");
      await app.plugins.enablePlugin("geode");
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await expect.poll(
      async () => await o.eval<number>(`app.plugins.plugins.geode?.lastBackupAt ?? 0`),
      { timeout: 15_000 },
    ).toBeGreaterThan(0);
    await expect.poll(
      async () => await syncStatusRow.locator(".setting-item-description").textContent(),
      { timeout: 15_000 },
    ).toMatch(/^Locked\. Nothing syncs until you unlock\. Last backup /);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
