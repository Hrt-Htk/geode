// Rule 5 size tripwire, evidence-based: complexity signals, not raw totals.
// Counts CODE lines only: blank lines and comment-only lines (`//` and
// `/* */` blocks) don't count. `server/` ≤300/file is blocking (security
// property). `core/`/`plugin/` ≤500/file is blocking as a monolith guard;
// >300 is a review candidate, printed without failing. Per-function size,
// cyclomatic complexity and nesting are enforced by ESLint in `deno task
// standards`.
//
// Usage: `deno run -R scripts/check-loc.ts [root]`

import { walk } from "jsr:@std/fs@^1/walk";
import { relative } from "jsr:@std/path@^1";

export const LIMITS: Record<string, number> = { server: 300, core: 500, plugin: 500 };
export const REVIEW_AT = 300;

function codeLines(src: string): number {
  let count = 0;
  let inBlock = false;
  for (const raw of src.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (line === "") continue;
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end === -1) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (line === "") continue;
    }
    if (line.startsWith("//") || line === "") continue;
    count++;
  }
  return count;
}

export type Loc = { path: string; dir: string; lines: number };

export async function locStats(root: string): Promise<Loc[]> {
  const out: Loc[] = [];
  for (const dir of ["server", "core", "plugin"]) {
    for await (const e of walk(`${root}/${dir}`, { exts: [".ts"], skip: [/_generated/] })) {
      out.push({
        path: relative(root, e.path).replaceAll("\\", "/"),
        dir,
        lines: codeLines(await Deno.readTextFile(e.path)),
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const root = Deno.args[0] ?? ".";
  const failures: string[] = [];
  const candidates: string[] = [];
  for (const { path, dir, lines } of await locStats(root)) {
    const limit = LIMITS[dir];
    if (lines > limit) failures.push(`${path}: ${lines} code lines (limit ${limit})`);
    else if (dir !== "server" && lines > REVIEW_AT) candidates.push(`${path}: ${lines} code lines`);
  }

  if (candidates.length) {
    console.log(
      `Review candidates (core/plugin over ${REVIEW_AT} code lines, not blocking):\n  ${
        candidates.join("\n  ")
      }`,
    );
  }
  if (failures.length) {
    console.error(`LOC tripwire (Rule 5):\n  ${failures.join("\n  ")}`);
    Deno.exit(1);
  }
}
