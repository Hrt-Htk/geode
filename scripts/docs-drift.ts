// Docs drift (#646): a changed file whose `covers:` globs match a doc, when
// none of those docs changed on the branch, has drifted from its doc: hard.
// A file only a doc's `watches:` globs match is a warning: print which doc to
// check, never fail. A changed file no doc attests is uncovered: informational,
// it surfaces code with no doc at all.
//
// Pure helpers (importable, unit-tested):
//   docsDrift(changed, docs) -> { drift, warnings, uncovered }
//   docsOptOut(body) -> the PR-body opt-out `docs: unaffected - <reason>`
//
// CLI (`deno task docs:drift`): changed files from `origin/main...HEAD` plus the
// working tree (staged, unstaged, untracked); warns and always exits 0. The CI
// gate-evidence job turns the same report's drift into a hard failure unless the
// PR body opts out.

import { coversOf, globToRegExp, watchesOf } from "./check-docs.ts";

export type DocGlobs = { doc: string; covers: string[]; watches: string[] };
export type Drift = { file: string; docs: string[] };
export type DriftReport = { drift: Drift[]; warnings: Drift[]; uncovered: string[] };

export const DRIFT_HINT = `Update the doc, or add "docs: unaffected - <reason>" to the PR body.`;

export const formatDrift = (d: Drift) =>
  `docs drift: ${d.file} changed, covered by ${d.docs.join(", ")} (not touched in this branch)`;

export const formatWarning = (w: Drift) =>
  `docs check: ${w.file} changed, see ${w.docs.join(", ")}`;

/** The docs whose `key` globs match `file`. */
const matching = (docs: DocGlobs[], file: string, key: "covers" | "watches") =>
  docs.filter((d) => d[key].some((g) => globToRegExp(g).test(file))).map((d) => d.doc);

export function docsDrift(changed: string[], docs: DocGlobs[]): DriftReport {
  const touched = new Set(changed);
  const report: DriftReport = { drift: [], warnings: [], uncovered: [] };
  for (const file of [...new Set(changed)].sort()) {
    if (file.endsWith(".md")) continue; // prose attests code; prose is not covered code
    const covers = matching(docs, file, "covers");
    if (covers.length) {
      if (!covers.some((d) => touched.has(d))) report.drift.push({ file, docs: covers });
      continue;
    }
    const watches = matching(docs, file, "watches");
    if (!watches.length) report.uncovered.push(file);
    else if (!watches.some((d) => touched.has(d))) report.warnings.push({ file, docs: watches });
  }
  return report;
}

/** The reviewable opt-out line a PR body may carry instead of a doc update. */
export const docsOptOut = (body: string) =>
  /^\s*docs:\s*unaffected[ \t]*-[ \t]*(?!<)\S/m.test(body);

async function* markdownFiles(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* markdownFiles(path);
    else if (e.name.endsWith(".md")) yield path;
  }
}

/** Every doc under `dir` with the `covers:` and `watches:` globs from its frontmatter. */
export async function readDocGlobs(dir = "docs"): Promise<DocGlobs[]> {
  const docs: DocGlobs[] = [];
  for await (const doc of markdownFiles(dir)) {
    const text = await Deno.readTextFile(doc);
    docs.push({ doc, covers: coversOf(text), watches: watchesOf(text) });
  }
  return docs.sort((a, b) => (a.doc < b.doc ? -1 : 1));
}

async function git(args: string[]): Promise<string[]> {
  const out = await new Deno.Command("git", { args, stderr: "piped" }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr).trim());
  return new TextDecoder().decode(out.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Branch commits, the working tree (staged and unstaged), and new files. */
async function changedFiles(): Promise<string[]> {
  const [branch, worktree, untracked] = await Promise.all([
    git(["diff", "--name-only", "origin/main...HEAD"]),
    git(["diff", "--name-only", "HEAD"]),
    git(["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...branch, ...worktree, ...untracked];
}

if (import.meta.main) {
  let changed: string[] | null = null;
  try {
    changed = await changedFiles();
  } catch (e) {
    console.error(`docs drift: skipped: ${(e as Error).message}`);
  }
  if (changed) {
    const { drift, warnings, uncovered } = docsDrift(changed, await readDocGlobs());
    if (uncovered.length) console.error(`docs drift: uncovered: ${uncovered.join(", ")}`);
    if (warnings.length) console.error(warnings.map(formatWarning).join("\n"));
    if (!drift.length) console.log("docs drift: none");
    else console.error(`${drift.map(formatDrift).join("\n")}\n${DRIFT_HINT}`);
  }
}
