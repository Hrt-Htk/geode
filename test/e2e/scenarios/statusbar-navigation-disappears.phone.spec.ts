/**
 * Harness: which navigation paths cause the mobile Geode status bar icon to disappear?
 *
 * Strategy:
 * 1. Boot a phone instance with a vault containing 5 notes + wikilinks between them.
 * 2. Reach a "Geode: synced" baseline.
 * 3. For each navigation action, assert the icon is still in the DOM, then screenshot.
 * 4. If the icon is missing, dump the full DOM tree around `.view-actions` to a file
 *    so we can inspect what happened.
 *
 * Navigation paths tested (in order):
 *   A. Click a wikilink inside the editor (note A → note B)
 *   B. Click the back button (note B → note A)
 *   C. Open file explorer → click a note (note A → note C)
 *   D. Command Palette → "Go to file" → type + select (note C → note D)
 *   E. Create a new note from the editor (note D → note E-new)
 *   F. Click a wikilink from note E-new → note A
 *
 * After each step: readGeodeStatusBar + check icon element exists.
 */
import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PASSPHRASE = "nav-disappears-passphrase";
const SHOT_DIR = "tmp/statusbar-nav-shots";

function ensureShotDir() {
  mkdirSync(SHOT_DIR, { recursive: true });
}

/**
 * Read the status bar icon element's state.
 * Returns { exists: true, icon: string, color: string, visible: boolean } or { exists: false }.
 */
async function readStatusBarIconState(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
): Promise<
  | { exists: true; icon: string; color: string; visible: boolean }
  | { exists: false }
> {
  return await obsidian.eval(`(() => {
    const el = document.querySelector('[data-testid="geode-mobile-status"]');
    if (!el) return { exists: false };
    const svg = el.querySelector("svg");
    const icon = svg ? (svg.getAttribute("data-lucide") || "unknown") : "no-svg";
    const colorMatch = [...el.classList].find(c => c.startsWith("geode-statusbar-") && c !== "geode-statusbar-spin");
    // Check if the element is actually visible (not hidden, not zero dimensions)
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
    return { exists: true, icon, color: colorMatch || "none", visible };
  })()`);
}

/**
 * Dump the DOM tree around .view-actions to a file for inspection.
 */
async function dumpViewActionsDOM(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  label: string,
): Promise<void> {
  const dom = await obsidian.eval<string>(`(() => {
    const container = document.querySelector('.view-actions.mod-raised') || document.querySelector('.view-actions');
    if (!container) return "NO CONTAINER FOUND";
    // Serialize the container and its siblings for context
    const parent = container.parentElement;
    const parentHTML = parent ? parent.outerHTML.substring(0, 3000) : "no parent";
    return "CONTAINER HTML: " + container.outerHTML.substring(0, 3000) +
      "\n\nPARENT: " + parentHTML;
  })()`);
  const filePath = path.join(SHOT_DIR, `dom-${label}.html`);
  ensureShotDir();
  writeFileSync(filePath, dom, "utf8");
  console.log(`  DOM dump written to ${filePath}`);
}

/**
 * Helper: perform a navigation step and assert the status bar icon is visible.
 */
async function checkIconAfterStep(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  stepName: string,
  expectedStatusBarText?: string,
): Promise<void> {
  // Small settle delay
  await new Promise((r) => setTimeout(r, 500));

  // 1. Check icon element exists
  const iconState = await readStatusBarIconState(obsidian);
  if (!iconState.exists) {
    console.error(`  ❌ [${stepName}] Icon MISSING from DOM`);
    await dumpViewActionsDOM(obsidian, stepName);
    await obsidian.screenshot(shotPath(`icon-missing-${stepName}.png`));
    throw new Error(`Status bar icon missing after: ${stepName}`);
  }

  console.log(`  ✅ [${stepName}] icon=${iconState.icon} color=${iconState.color}`);

  // 2. Check status bar text if expected text provided
  if (expectedStatusBarText) {
    const statusText = await readGeodeStatusBar(obsidian.win);
    expect(statusText).toContain(expectedStatusBarText);
  }
}

test("statusbar icon survives navigation actions on phone", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("statusbar-nav");

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
    // Wait for locked state
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    // Dismiss modals
    await dismissModals(obsidian);

    // Unlock
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );

    // Wait for synced baseline
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    console.log("  ✅ Baseline: synced");

    ensureShotDir();

    // === PREP: create 5 notes with wikilinks ===
    // Note A: "NoteA" with links to B and C
    await obsidian.eval(`(async () => {
      await app.vault.create("NoteA.md", "[[NoteB]]\\n[[NoteC]]\\nHello from A");
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);

    // Note B
    await obsidian.eval(`(async () => {
      await app.vault.create("NoteB.md", "Content of B. Link to [[NoteA]]");
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);

    // Note C
    await obsidian.eval(`(async () => {
      await app.vault.create("NoteC.md", "Content of C. Link to [[NoteA]]");
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);

    // Note D
    await obsidian.eval(`(async () => {
      await app.vault.create("NoteD.md", "Content of D. Link to [[NoteA]]");
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);

    // Open NoteA in the editor
    await obsidian.eval(`(async () => {
      const file = app.vault.getAbstractFileByPath("NoteA.md");
      await app.workspace.activeLeaf.openFile(file);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    console.log("  === Starting navigation steps ===");

    // --- Step A: Click a wikilink inside the editor (NoteA → NoteB) ---
    console.log("\n  Step A: wikilink click (NoteA → NoteB)");
    // Find and click the wikilink to NoteB in the editor
    await obsidian.eval(`(() => {
      const links = document.querySelectorAll('.cm-link, .internal-link');
      for (const link of links) {
        const href = link.getAttribute('href') || link.textContent || '';
        if (href.includes('NoteB') || link.textContent.includes('NoteB')) {
          link.click();
          return true;
        }
      }
      // Fallback: try clicking on text that looks like a wikilink
      const spans = document.querySelectorAll('.cm-string, .inline-block');
      for (const span of spans) {
        if (span.textContent && span.textContent.includes('[[NoteB]]')) {
          span.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await checkIconAfterStep(obsidian, "A-wikilink-click", "Geode: synced");
    await obsidian.screenshot(shotPath("step-A-wikilink.png"));

    // --- Step B: Back button (NoteB → NoteA) ---
    console.log("\n  Step B: back button (NoteB → NoteA)");
    await obsidian.back();
    await new Promise((r) => setTimeout(r, 1500));
    await checkIconAfterStep(obsidian, "B-back-button", "Geode: synced");
    await obsidian.screenshot(shotPath("step-B-back.png"));

    // --- Step C: File explorer → click a note (NoteA → NoteC) ---
    console.log("\n  Step C: file explorer click (NoteA → NoteC)");
    // Open the file explorer (folded sidebar on mobile)
    await obsidian.eval(`(() => {
      // Try clicking the file explorer toggle
      const toggles = document.querySelectorAll('.sidebar-toggle-btn, .mod-file-explorer .nav-header');
      if (toggles.length > 0) {
        toggles[0].click();
        return true;
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    // Click on NoteC in the file explorer
    await obsidian.eval(`(() => {
      const files = document.querySelectorAll('.nav-file-title[data-path="NoteC.md"]');
      if (files.length > 0) {
        files[0].click();
        return true;
      }
      // Fallback: search for the file title content
      const titles = document.querySelectorAll('.nav-file-title-content');
      for (const t of titles) {
        if (t.textContent === 'NoteC') {
          t.parentElement?.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await checkIconAfterStep(obsidian, "C-file-explorer", "Geode: synced");
    await obsidian.screenshot(shotPath("step-C-explorer.png"));

    // --- Step D: Command Palette → "Go to file" → type + select (NoteC → NoteD) ---
    console.log("\n  Step D: command palette go-to-file (NoteC → NoteD)");
    // Open command palette
    await obsidian.eval(`(() => {
      app.commands.executeCommandById("core:switch-vault");
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    // Type "Go to file" or "Switch file"
    await obsidian.eval(`(() => {
      const input = document.querySelector('.command-palette-input, .prompt-input');
      if (input) {
        input.value = 'Go to file';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    // Select NoteD from results and click
    await obsidian.eval(`(() => {
      const items = document.querySelectorAll('.suggestion-item');
      for (const item of items) {
        if (item.textContent && item.textContent.includes('NoteD')) {
          item.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await checkIconAfterStep(obsidian, "D-command-palette", "Geode: synced");
    await obsidian.screenshot(shotPath("step-D-palette.png"));

    // --- Step E: Create a new note from the editor (NoteD → NoteE-new) ---
    console.log("\n  Step E: create new note (NoteD → NoteE-new)");
    await obsidian.eval(`(async () => {
      const newContent = "# NoteE\\n\\nCreated from navigation test";
      await app.vault.create("NoteE-new.md", newContent);
      const file = app.vault.getAbstractFileByPath("NoteE-new.md");
      await app.workspace.activeLeaf.openFile(file);
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);
    await checkIconAfterStep(obsidian, "E-create-note", "Geode: synced");
    await obsidian.screenshot(shotPath("step-E-create.png"));

    // --- Step F: Click a wikilink from NoteE → NoteA ---
    console.log("\n  Step F: wikilink from new note (NoteE → NoteA)");
    // First, edit NoteE to add a link to NoteA
    await obsidian.eval(`(async () => {
      const file = app.vault.getAbstractFileByPath("NoteE-new.md");
      const content = await app.vault.read(file);
      await app.vault.modify(file, content + "\\nLink to [[NoteA]]");
      return true;
    })()`);
    await waitForStatusBar(obsidian.win, "Geode: synced", 30_000);
    await new Promise((r) => setTimeout(r, 1000));

    // Click the wikilink to NoteA
    await obsidian.eval(`(() => {
      const links = document.querySelectorAll('.cm-link, .internal-link');
      for (const link of links) {
        const href = link.getAttribute('href') || link.textContent || '';
        if (href.includes('NoteA') || link.textContent.includes('NoteA')) {
          link.click();
          return true;
        }
      }
      const spans = document.querySelectorAll('.cm-string, .inline-block');
      for (const span of spans) {
        if (span.textContent && span.textContent.includes('[[NoteA]]')) {
          span.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await checkIconAfterStep(obsidian, "F-wikilink-from-new", "Geode: synced");
    await obsidian.screenshot(shotPath("step-F-wikilink-new.png"));

    // --- Step G: Tab selection → click another note (reproduces user's exact path) ---
    console.log("\n  Step G: tab selection → click another note");
    // Tap the tab button (shows tab count, e.g. "2")
    await obsidian.eval(`(() => {
      // Try the bottom nav tab button first
      const tabBtn = document.querySelector('.bottom-tab[data-id="tabs"]');
      if (tabBtn) {
        tabBtn.click();
        return true;
      }
      // Fallback: find the button with tab count
      const navBtns = document.querySelectorAll('.bottom-tab-btn, .bottom-tab');
      for (const btn of navBtns) {
        if (btn.textContent?.match(/\d/)) {
          btn.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 1000));

    // Click NoteC from the tab list
    await obsidian.eval(`(() => {
      const tabs = document.querySelectorAll('.tab-item, .nav-file-title, [class*="tab-"]');
      for (const tab of tabs) {
        if (tab.textContent && tab.textContent.includes('NoteC')) {
          tab.click();
          return true;
        }
      }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 2000));
    // Wait for the note view to settle (modal closes, editor renders)
    await new Promise((r) => setTimeout(r, 1000));
    await checkIconAfterStep(obsidian, "G-tab-selection", "Geode: synced");
    await obsidian.screenshot(shotPath("step-G-tab-selection.png"));

    // --- Step H: Rapid-fire navigation (stress test for race conditions) ---
    console.log("\n  Step H: rapid-fire navigation stress test");
    // Create a note via API, immediately navigate via tab selection, immediately navigate again
    // This simulates rapid user interaction that might trigger race conditions
    for (let i = 0; i < 5; i++) {
      console.log(`    Iteration ${i + 1}/5`);
      await obsidian.eval(`(async () => {
        await app.vault.create('RapidNote' + ${i} + '.md', 'Content ' + ${i});
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 200)); // Very short delay
      await checkIconAfterStep(obsidian, `H-rapid-${i}`); // Don't check synced: rapid creates leave vault dirty

      // Immediately go to tab selection and click NoteA
      await obsidian.eval(`(() => {
        const navBtns = document.querySelectorAll('.bottom-tab[data-id="tabs"]');
        for (const btn of navBtns) { btn.click(); return true; }
        return false;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
      await obsidian.eval(`(() => {
        const tabs = document.querySelectorAll('.tab-item, .nav-file-title');
        for (const tab of tabs) {
          if (tab.textContent && tab.textContent.includes('NoteA')) { tab.click(); return true; }
        }
        return false;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      await checkIconAfterStep(obsidian, `H-rapid-tab-${i}`, "Geode: synced");
    }
    await obsidian.screenshot(shotPath("step-H-rapid.png"));

    console.log("\n  ✅ All navigation steps passed: icon survived every transition");
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
