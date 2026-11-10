import { expect } from "@playwright/test";
import type { Evaluatable } from "./device-abstraction";

// The four control rows the specs drive by name (#16): renamed in one place, they break the E2E at
// compile time instead of silently mis-targeting a row.
export {
  AUTO_LOCK_ROW,
  DEVELOPER_CONSOLE_ROW,
  SYNC_CONFIG_ROW,
  TRASH_RETENTION_ROW,
} from "../../../plugin/ui/settings-row-names.ts";

// #16: Obsidian 1.13+ renders the Geode tab from setting definitions: headed groups, with
// Advanced and Logs as sub-pages. display() (Obsidian < 1.13, or useDisplayPath below) renders
// the same rows in collapsible sections. Every helper here works on both paths, desktop and
// phone (in-page eval: mobile animations never let Playwright locators settle).

/** In-page: the visible settings row whose name is `name` (a page entry is a row too). */
const FIND_ROW = `((name) => [...document.querySelectorAll(".modal.mod-settings .setting-item")]
  .find((r) => r.offsetParent !== null &&
    r.querySelector(".setting-item-name")?.textContent?.trim() === name))`;

/** Render the tab through display() on Obsidian 1.13+ too (the E2E hook on the tab). */
export async function useDisplayPath(o: Evaluatable, on = true): Promise<void> {
  await o.eval(`(() => {
    const tab = app.plugins.plugins.geode.settingTab;
    tab.legacyForTest = ${on};
    tab.refresh();
    return true;
  })()`);
}

/** True when the open tab was rendered by display() (collapsible sections). */
export function isDisplayPath(o: Evaluatable): Promise<boolean> {
  return o.eval<boolean>(`!!document.querySelector(".modal.mod-settings .geode-section")`);
}

/** Drop the transient Notice overlays before a screenshot. */
export async function clearNotices(o: Evaluatable): Promise<void> {
  await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
}

/** Scroll the named heading to the top of the pane (a phone's translucent header needs a
 * `margin`), and say whether it was there. */
export function scrollToHeading(o: Evaluatable, name: string, margin = 0): Promise<boolean> {
  return o.eval<boolean>(`(() => {
    const el = [...document.querySelectorAll(
      ".modal.mod-settings .setting-item-heading, .modal.mod-settings .setting-group-heading, .modal.mod-settings .setting-item-name"
    )].find((e) => e.textContent.trim() === ${JSON.stringify(name)});
    if (el) {
      ${margin ? `el.style.scrollMarginTop = "${margin}px";` : ""}
      el.scrollIntoView({ block: "start" });
    }
    return !!el;
  })()`);
}

/** The two paths render the same rows: display() against the definitions pages. */
export function expectSameRows(
  display: string[],
  defs: { main: string[]; advanced: string[]; logs: string[] },
): void {
  const pageEntries = ["Advanced | ", "Logs | "];
  expect(defs.main, "Advanced and Logs are page entries").toEqual(
    expect.arrayContaining(pageEntries),
  );
  const defsRows = [...defs.main, ...defs.advanced, ...defs.logs]
    .filter((r) => !pageEntries.includes(r));
  expect([...display].sort()).toEqual(defsRows.sort());
}

/** Scroll whichever settings pane is scrollable to `to`, and return the offset it took. */
export async function scrollSettings(o: Evaluatable, to: number): Promise<number> {
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

/** The settings pane's scroll offset, 0 when it sits at the top. */
export function readScroll(o: Evaluatable): Promise<number> {
  return o.eval<number>(`
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

/** Show the Advanced or Logs rows: open the sub-page, or expand the section on display(). */
export async function openSettingsPage(o: Evaluatable, name: "Advanced" | "Logs"): Promise<void> {
  await o.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const heading = [...document.querySelectorAll(".modal.mod-settings .geode-section")]
      .map((s) => s.querySelector(".geode-collapsible-heading"))
      .find((h) => h?.textContent?.trim() === name);
    if (heading) {
      if (heading.nextElementSibling?.classList.contains("geode-collapsed")) heading.click();
      heading.scrollIntoView({ block: "start" });
      return true;
    }
    const entry = ${FIND_ROW}(name);
    if (!entry) throw new Error("openSettingsPage: no entry " + name);
    entry.click();
    return true;
  })()`);
  const first = name === "Advanced" ? "Server address" : "Copy logs";
  await expect.poll(() => o.eval<boolean>(`!!${FIND_ROW}(${JSON.stringify(first)})`), {
    timeout: 10_000,
  }).toBe(true);
}

/** Back from a sub-page to the tab (no-op on display()). */
export async function closeSettingsPage(o: Evaluatable): Promise<void> {
  await o.eval(`(() => {
    document.querySelector(".modal.mod-settings .setting-page-back-button")?.click();
    return true;
  })()`);
}

/** Whether the named row is shown. */
export function rowShown(o: Evaluatable, name: string): Promise<boolean> {
  return o.eval<boolean>(`!!${FIND_ROW}(${JSON.stringify(name)})`);
}

/** The named row's input value (number controls) or toggle state ("on"/"off"). */
export function readRowControl(o: Evaluatable, name: string): Promise<string> {
  return o.eval<string>(`(() => {
    const row = ${FIND_ROW}(${JSON.stringify(name)});
    if (!row) throw new Error("readRowControl: no row " + ${JSON.stringify(name)});
    const toggle = row.querySelector(".checkbox-container");
    if (toggle) return toggle.classList.contains("is-enabled") ? "on" : "off";
    return row.querySelector("input").value;
  })()`);
}

/** Centre the named row in the pane. `setRowControl` does it too: focusing an off-screen
 * control makes the pane scroll to it, which a scrollTop check would read as a re-render. */
export async function scrollRowIntoView(o: Evaluatable, name: string): Promise<void> {
  await o.eval(`(() => {
    const row = ${FIND_ROW}(${JSON.stringify(name)});
    if (!row) throw new Error("scrollRowIntoView: no row " + ${JSON.stringify(name)});
    row.scrollIntoView({ block: "center" });
    return true;
  })()`);
}

/** Flip the named row's toggle, or type a value into its input and commit it. Scrolls the row
 * into view first: focusing an off-screen control makes the pane scroll to it, which is not a
 * re-render and would look like one to a scrollTop check. */
export async function setRowControl(o: Evaluatable, name: string, value?: string): Promise<void> {
  await o.eval(`(() => {
    const row = ${FIND_ROW}(${JSON.stringify(name)});
    if (!row) throw new Error("setRowControl: no row " + ${JSON.stringify(name)});
    row.scrollIntoView({ block: "center" });
    const toggle = row.querySelector(".checkbox-container");
    if (toggle) {
      toggle.click();
      return true;
    }
    const input = row.querySelector("input");
    input.value = ${JSON.stringify(value ?? "")};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur"));
    return true;
  })()`);
}

/** Every shown row as "name | testids", the comparison both paths must agree on. */
export function rowInventory(o: Evaluatable): Promise<string[]> {
  return o.eval<string[]>(`(() =>
    [...document.querySelectorAll(".modal.mod-settings .setting-item:not(.setting-item-heading)")]
      .filter((r) => r.offsetParent !== null)
      .map((r) => {
        const name = r.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
        const ids = [r, ...r.querySelectorAll("[data-testid]")]
          .map((e) => e.dataset.testid).filter(Boolean).sort();
        return name + " | " + ids.join(" ");
      }))()`);
}

/** Type into Obsidian's settings search and return the result rows' text. */
export async function searchSettings(o: Evaluatable, query: string): Promise<string[]> {
  await o.eval(`(() => {
    const input = document.querySelector('.modal.mod-settings input[type="search"]');
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  return await o.eval<string[]>(`[...document.querySelectorAll(
    ".modal.mod-settings .setting-search-result-group"
  )].map((g) => g.textContent.trim())`);
}

/** The shown section names in order: headings, then the Advanced and Logs page entries. On
 * 1.13+ the Status block has no heading: unlocked reads Vault, Devices, Sync scope, Trash,
 * Advanced (+ Logs). */
export function shownSections(o: Evaluatable): Promise<string[]> {
  return o.eval<string[]>(`(() => {
    const shown = (e) => e.offsetParent !== null;
    const headings = [...document.querySelectorAll(".modal.mod-settings .setting-item-heading")]
      .filter(shown).map((h) => h.textContent.trim());
    const pages = [...document.querySelectorAll(".modal.mod-settings .setting-item")]
      .filter((r) => shown(r) && r.querySelector(".setting-item-name")?.textContent?.trim().match(/^(Advanced|Logs)$/) && !r.classList.contains("setting-item-heading"))
      .map((r) => r.querySelector(".setting-item-name").textContent.trim());
    return [...headings, ...pages];
  })()`);
}

/** Mark the live sync-status row's dot: any re-render of the row replaces it, an in-place
 * update keeps it. Returns the check. */
export async function markNoRerender(o: Evaluatable): Promise<() => Promise<boolean>> {
  await o.eval(`(() => {
    const dot = document.querySelector('[data-testid="geode-settings-sync-status"] .geode-sync-dot');
    if (!dot) throw new Error("markNoRerender: no sync-status dot");
    dot.dataset.e2eMarker = "no-rerender";
    return true;
  })()`);
  return () =>
    o.eval<boolean>(`!!document.querySelector('.geode-sync-dot[data-e2e-marker="no-rerender"]')`);
}
