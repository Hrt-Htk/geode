import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import type { ObsidianInstance } from "../fixtures/obsidian";

// #8: the settings the docs images are shot in, and where they land.

// The committed images: not gitignored, so a reshoot overwrites the tracked file in place.
const DOCS_ROOT = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");

export function docsShot(name: string): string {
  mkdirSync(DOCS_ROOT, { recursive: true });
  return path.join(DOCS_ROOT, `${name}.png`);
}

/** Pin the window size: the images are cropped to the surface, so layout must not drift. */
export async function fixWindow(o: ObsidianInstance, height = 860): Promise<void> {
  await o.win.setViewportSize({ width: 1280, height });
  // One settling delay, so Obsidian's layout has moved to the new size before the shot.
  await new Promise((r) => setTimeout(r, 300));
}

/** Obsidian's default theme, dark. No community theme, no CSS snippet. */
export async function useDarkTheme(o: ObsidianInstance): Promise<void> {
  await o.eval(`
    app.changeTheme("obsidian");
    await new Promise((r) => setTimeout(r, 500));
    return true;
  `);
  await expect.poll(async () => await o.eval<string>("document.body.className")).toContain(
    "theme-dark",
  );
}

/** Screenshot the whole window, or one surface with `selector`, notices cleared first. */
export async function shoot(
  o: ObsidianInstance,
  name: string,
  selector?: string,
): Promise<void> {
  await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
  const target = selector ? o.win.locator(selector).first() : o.win;
  await target.screenshot({ path: docsShot(name), scale: "css", animations: "disabled" });
}
