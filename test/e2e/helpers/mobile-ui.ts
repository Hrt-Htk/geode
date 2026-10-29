/**
 * Mobile WebView interaction helpers.
 *
 * Obsidian mobile 1.13.4 runs persistent CSS animations on modals/settings/wizard
 * elements, so Playwright actionability ("visible, enabled and stable") never settles
 * and locator .click()/.fill()/.press() hang. Drive the element in-page instead.
 */
export interface MobileUI {
  eval: (code: string) => Promise<unknown>;
}

export async function evalClick(ui: MobileUI, selector: string): Promise<void> {
  await ui.eval(`
    (() => {
      const sel = ${JSON.stringify(selector)};
      const el = document.querySelector(sel);
      if (!el) throw new Error("evalClick: element not found: " + sel);
      el.click();
      return true;
    })()
  `);
}

export async function evalSetValue(ui: MobileUI, selector: string, value: string): Promise<void> {
  await ui.eval(`
    (() => {
      const sel = ${JSON.stringify(selector)};
      const el = document.querySelector(sel);
      if (!el) throw new Error("evalSetValue: element not found: " + sel);
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

/** Close any open modals in-page (close buttons first, backdrop fallback, then remove). */
export async function dismissModals(ui: MobileUI): Promise<void> {
  await ui.eval(`
    (async () => {
      for (let i = 0; i < 8 && document.querySelectorAll(".modal-container").length > 0; i++) {
        const close = document.querySelectorAll(".modal-close-button");
        if (close.length > 0) close[close.length - 1].click();
        else {
          const backdrop = document.querySelectorAll(".modal-bg");
          if (backdrop.length > 0) backdrop[backdrop.length - 1].click();
          else document.querySelector(".modal-container")?.remove();
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return true;
    })()
  `);
}
