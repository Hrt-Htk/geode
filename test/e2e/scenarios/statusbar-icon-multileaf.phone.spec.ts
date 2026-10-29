/**
 * Regression test for Geode #296: mobile status-bar icon stranded in hidden leaf.
 *
 * Flow: create note #1 via real taps → create note #2 via real taps → assert icon is
 * visible in the ACTIVE leaf's `.view-actions.mod-raised` container.
 *
 * Bug: after note #2 the button stays connected in a now-hidden background container.
 * The MutationObserver guard never fires because the button remains isConnected with a
 * valid parent → the button is stranded.
 */
import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { requireEnv } from "../env.ts";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { mkdirSync } from "node:fs";
import path from "node:path";

const PASSPHRASE = "ui-tap-passphrase";
const TMP_DIR = "tmp";

function ensureDir() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function adbTap(serial: string, x: number, y: number): void {
  const { spawnSync } = require("node:child_process");
  const ADB = process.env.ADB_PATH || "adb";
  const result = spawnSync(ADB, ["-s", serial, "shell", "input", "tap", String(x), String(y)], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    console.warn(`  ⚠️ adb tap (${x},${y}) failed: ${result.stderr?.trim() || "unknown"}`);
  }
}

/** Read the mobile status icon state. */
async function readIconState(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  _label: string,
): Promise<{
  exists: boolean;
  visible: boolean;
  inActiveLeaf: boolean;
  visibleContainerHasButton: boolean;
}> {
  return await obsidian.eval<any>(`
    (function() {
      var btn = document.querySelector('[data-testid="geode-mobile-status"]');
      // Tablets render .view-actions WITHOUT mod-raised (phones add it); match either (#309).
      var containers = Array.from(document.querySelectorAll('.view-actions'));
      var activeLeaf = document.querySelector('.workspace-leaf.mod-active');

      if (!btn) return { exists: false, visible: false, inActiveLeaf: false, visibleContainerHasButton: false };

      var br = btn.getBoundingClientRect();
      var exists = true;
      var visible = btn.offsetParent !== null && br.width > 0 && br.height > 0;

      var inActiveLeaf = (function() {
        var header = btn.closest('.workspace-leaf-header') || btn.parentElement;
        return header && activeLeaf ? activeLeaf.contains(header) : false;
      })();

      var visibleContainerHasButton = containers.some(function(c) {
        var rect = c.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && c.offsetParent !== null && c.contains(btn);
      });

      return { exists, visible, inActiveLeaf, visibleContainerHasButton };
    })()
  `);
}

/**
 * Create one note in a NEW leaf. Prefers real ADB taps (plus → empty-state "Create new note");
 * falls back to a programmatic new-leaf create when the tap targets aren't present: the tablet's
 * empty-state layout doesn't expose the same mobile-navbar "+" / empty-state action button. Either
 * path opens a fresh active leaf, which is what the active-leaf assertion below actually exercises.
 */
async function createNoteViaRealTaps(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  serial: string,
): Promise<boolean> {
  const programmaticFallback = async (why: string): Promise<boolean> => {
    console.log(`  ↪ real-tap path unavailable (${why}); creating note in a new leaf via API`);
    return await obsidian.eval<boolean>(`(async () => {
      const name = "multileaf-" + Date.now() + ".md";
      await app.vault.create(name, "# " + name + "\\n");
      const f = app.vault.getAbstractFileByPath(name);
      await app.workspace.getLeaf(true).openFile(f);
      return true;
    })()`);
  };

  // Step 1: Tap "+" button
  const plusBtn = await obsidian.eval<any>(`(function() {
    var el = document.querySelector('.mobile-navbar-action-new-tab');
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    return {
      screenCenter: { x: Math.round((rect.x + rect.width/2) * dpr), y: Math.round((rect.y + rect.height/2) * dpr) },
    };
  })()`);

  if (!plusBtn) return await programmaticFallback("+ button not found");
  adbTap(serial, plusBtn.screenCenter.x, plusBtn.screenCenter.y);
  await new Promise((r) => setTimeout(r, 1000));

  // Step 2: Tap "Create new note"
  const createBtn = await obsidian.eval<any>(`(function() {
    var el = document.querySelector('.empty-state-action');
    if (!el) return null;
    var text = (el.textContent || '').trim().toLowerCase();
    if (text.indexOf('create new note') === -1) return null;
    var rect = el.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    return {
      screenCenter: { x: Math.round((rect.x + rect.width/2) * dpr), y: Math.round((rect.y + rect.height/2) * dpr) },
    };
  })()`);

  if (!createBtn) {
    return await programmaticFallback("'Create new note' empty-state button not found");
  }

  adbTap(serial, createBtn.screenCenter.x, createBtn.screenCenter.y);
  await new Promise((r) => setTimeout(r, 1500));

  return true;
}

// ──────────────────────────────────────────────
// Test
// ──────────────────────────────────────────────

test("status-bar icon must be visible in active leaf after creating note #2", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("ui-tap-probe");

  const serial = requireEnv("ANDROID_SERIAL");
  const obsidian = await connectPhone({
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
    ensureDir();

    // ── Wait for synced baseline ──
    await dismissModals(obsidian);
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    console.log("  ✅ Baseline: synced");

    // ── Create note #1 via REAL ADB taps ──
    console.log("\n  === CREATE NOTE #1 ===");
    const note1Created = await createNoteViaRealTaps(obsidian, serial);
    expect(note1Created).toBe(true);

    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);
    await readIconState(obsidian, "after-note1");

    // ── Create note #2 via REAL ADB taps ──
    console.log("\n  === CREATE NOTE #2 ===");
    const note2Created = await createNoteViaRealTaps(obsidian, serial);
    expect(note2Created).toBe(true);

    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);

    // ── ASSERT: icon must be visible in the active leaf ──
    try {
      const state = await readIconState(obsidian, "after-note2");

      expect(state.exists).toBe(true);
      expect(state.visible).toBe(true);
      expect(state.inActiveLeaf).toBe(true);
      expect(state.visibleContainerHasButton).toBe(true);
    } catch (e) {
      await obsidian.screenshot(path.join(TMP_DIR, "statusbar-multileaf-failure.png"));
      throw e;
    }

    console.log("\n  ✅ Test passed: icon is visible in active leaf");
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
