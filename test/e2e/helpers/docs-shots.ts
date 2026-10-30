import type { Page } from "@playwright/test";
import { docsShot } from "./shots";

// #8: the settings the docs images are shot in, so a reshoot does not change every image for
// nothing: one window size on both desktops, and Obsidian's own default (dark) theme.

export type ShotTarget = {
  win: Page;
  eval: <T>(jsExpr: string) => Promise<T>;
};

/** Pin the desktop window size: the images are cropped to the surface, so layout must not drift. */
export async function fixWindow(win: Page, width = 1280, height = 860): Promise<void> {
  await win.setViewportSize({ width, height });
  // One settling delay, so Obsidian's layout has moved to the new size before the shot.
  await new Promise((r) => setTimeout(r, 300));
}

/** Obsidian's default theme, dark. No community theme, no CSS snippet. */
export async function useDarkTheme(target: ShotTarget): Promise<void> {
  await target.eval(`
    app.changeTheme("obsidian");
    await new Promise((r) => setTimeout(r, 500));
    return true;
  `);
}

/** Screenshot one surface, with the transient notices cleared so they do not cover it. */
export async function shoot(target: ShotTarget, selector: string, name: string): Promise<void> {
  await target.eval(
    `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
  );
  await target.win.locator(selector).first().screenshot({ path: docsShot(name) });
}
