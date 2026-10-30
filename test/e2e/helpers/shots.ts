import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

// Screenshots live outside Playwright's outputDir (test/e2e/test-results), which is wiped at
// the start of every run: a phone/hybrid run would delete the desktop shots of the previous
// run (#487). One folder per spec + project; a run only overwrites its own files.
const ROOT = path.resolve(__dirname, "..", "screenshots");
// The images the README and docs/screenshots/README.md show: committed, not gitignored, so a
// reshoot (deno task docs:screenshots) overwrites the tracked file in place.
const DOCS_ROOT = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");

export function docsShot(name: string): string {
  mkdirSync(DOCS_ROOT, { recursive: true });
  return path.join(DOCS_ROOT, name.endsWith(".png") ? name : `${name}.png`);
}

export function shotPath(name: string): string {
  const info = test.info();
  const spec = path.basename(info.file, ".spec.ts");
  const dir = path.join(ROOT, spec, info.project.name);
  mkdirSync(dir, { recursive: true });
  const file = path.basename(name);
  return path.join(dir, file.endsWith(".png") ? file : `${file}.png`);
}
