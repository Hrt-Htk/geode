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

/**
 * Close any open modals in-page and wait until they are gone from the DOM.
 *
 * On the phone a modal closes with an animation: the container detaches only
 * when it ends, and Obsidian finishes its own bookkeeping then. Opening the next
 * modal before that runs into the previous modal's teardown, which closes the
 * new sheet by itself (any Geode modal, no user input: #68). Poll the containers
 * out, never sleep a fixed time.
 */
export async function dismissModals(ui: MobileUI): Promise<void> {
  await ui.eval(`
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const open = () => document.querySelectorAll(".modal-container").length;
      for (let round = 0; round < 10 && open() > 0; round++) {
        const containers = document.querySelectorAll(".modal-container");
        const last = containers[containers.length - 1];
        const close = last.querySelector(".modal-close-button");
        if (close) close.click();
        else last.querySelector(".modal-bg")?.click();
        for (let i = 0; i < 30 && open() > 0; i++) await wait(50);
      }
      // Drop any straggler the close never detached: its teardown still runs a
      // tick later, so give it one before the next modal opens.
      document.querySelectorAll(".modal-container").forEach((c) => c.remove());
      await wait(150);
      return true;
    })()
  `);
}
