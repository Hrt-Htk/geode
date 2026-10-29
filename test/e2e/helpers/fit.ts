import { expect, type Locator } from "@playwright/test";

const CONTROLS = "button, input, select, textarea";

/**
 * #638: a modal's contents must fit it: every visible control sits inside the
 * scope's horizontal bounds and no scroll pane overflows sideways. Catches the
 * phone-only failure a screenshot comparison to a wrong mockup hid.
 */
export async function expectFits(scope: Locator): Promise<void> {
  if (!(await scope.isVisible())) throw new Error(`expectFits: scope is not visible: ${scope}`);

  const overflow = await scope.evaluate((root) => {
    const panes = [root, ...root.querySelectorAll("*")];
    return panes
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1;
      })
      .map((el) =>
        `${el.tagName.toLowerCase()}.${
          el.getAttribute("class") ?? ""
        } scrolls ${el.scrollWidth} in ${el.clientWidth}`
      );
  });
  expect(overflow, "horizontal overflow inside the modal").toEqual([]);

  // One in-page pass: a long list (1,850 rows) over CDP to a phone is too slow per control.
  const outside = await scope.evaluate((root, selector) => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>(selector)]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) =>
        (r.width > 0 || r.height > 0) && getComputedStyle(el).visibility !== "hidden" &&
        (r.left < bounds.left - 1 || r.right > bounds.right + 1)
      )
      .map(({ el, r }) => {
        const label = el.dataset.testid ?? el.innerText?.trim() ?? el.tagName;
        return `"${label}" ${Math.round(r.left)}..${Math.round(r.right)} ` +
          `outside ${Math.round(bounds.left)}..${Math.round(bounds.right)}`;
      });
  }, CONTROLS);
  expect(outside, "controls past the modal's horizontal bounds").toEqual([]);
}
