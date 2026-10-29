// Docs gate (#645): structural drift in prose fails `deno task standards`.
// Five checks over the docs set: a cited repo path that does not exist, a
// relative markdown link that does not resolve, a `deno task <name>` missing
// from `deno.json`, a doc under `docs/` that no root doc reaches, and its
// `covers:`/`watches:` frontmatter (present, inline, every glob matching a real
// path: #646).
//
// Citations come from inline code spans and every fence, tagged or untagged:
// a pasted sample can cite a path just as a command can.
//
// Usage: `deno run -R scripts/check-docs.ts [root]`

import { dirname, join, normalize, relative } from "jsr:@std/path@^1";

export type FrontmatterKey = "covers" | "watches";
export type Hit = { line: number; value: string };
export type Violation = {
  file: string;
  line: number;
  kind:
    | "dead path"
    | "broken link"
    | "missing task"
    | "orphan doc"
    | "missing covers"
    | `bad ${FrontmatterKey}`
    | `dead ${FrontmatterKey}`;
  detail: string;
};

const CITED = "server core plugin test scripts db deploy docs .github .claude .agents".split(" ");
// Docs that every doc under `docs/` must be reachable from.
const ROOTS = "CLAUDE.md README.md CONTRIBUTING.md test/README.md server/README.md plugin/README.md"
  .split(" ");
// Build/test output: gitignored, legitimately cited by the docs describing it,
// absent on a fresh clone.
const GENERATED = "plugin-dist plugin/_generated test-results test/e2e/screenshots"
  .split(" ");
const SKIP = ["node_modules", ".git", ".deno", "tmp", "data", "playwright-report", ...GENERATED];

// `:` in the lookbehind keeps `npm:core/x` from reading as a repo path.
const TOKEN = new RegExp(
  `(?<![\\w/.@:-])((?:${CITED.map((d) => d.replace(/\./g, "\\.")).join("|")})/[\\w.*{}/-]*)`,
  "g",
);

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** `code` is the line's inline spans outside a fence, the whole line inside
 * one; `fenced` marks fenced lines, where markdown syntax is literal. */
function* lines(
  text: string,
): Generator<{ n: number; raw: string; code: string; fenced: boolean }> {
  let fence = "";
  for (const [i, raw] of text.split("\n").entries()) {
    const [marker = "", rest = ""] = raw.match(FENCE)?.slice(1) ?? [];
    const closes = marker[0] === fence[0] && marker.length >= fence.length && !rest.trim();
    if (!fence && marker) fence = marker;
    else if (fence && closes) fence = "";
    else if (fence) yield { n: i + 1, raw, code: raw, fenced: true };
    else {
      yield {
        n: i + 1,
        raw,
        code: [...raw.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join(" "),
        fenced: false,
      };
    }
  }
}

export function citedPaths(text: string): Hit[] {
  const hits = new Map<string, Hit>();
  for (const { n, code } of lines(text)) {
    for (const m of code.matchAll(TOKEN)) {
      const value = m[1].replace(/\.+$/, "").replace(/\/$/, "");
      hits.set(`${n}:${value}`, { line: n, value });
    }
  }
  return [...hits.values()];
}

export function markdownLinks(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { n, raw, fenced } of lines(text)) {
    if (fenced) continue;
    for (const m of raw.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) hits.push({ line: n, value: m[1] });
  }
  return hits;
}

/** Repo-relative path a link target points at, or null when it points outside. */
export function resolves(from: string, target: string): string | null {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(target)) return null;
  const path = decodeURIComponent(target.replace(/[#?].*$/, ""));
  if (!path) return null;
  return normalize(join(dirname(from), path)).replaceAll("\\", "/").replace(/\/$/, "");
}

export function citedTasks(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    for (const m of raw.matchAll(/deno task ([\w:-]+)/g)) hits.push({ line: i + 1, value: m[1] });
  }
  return hits;
}

export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^$()|[\]\\]/g, (c) => `\\${c}`)
    .replace(/\{([^}]*)\}/g, (_, group: string) => `(?:${group.replaceAll(",", "|")})`)
    // `**/` may span zero segments (`test/**/*.ts` matches `test/a.ts`).
    .replace(/\*\*\/|\*\*|\*/g, (m) => m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*");
  return new RegExp(`^${body}$`);
}

/** The doc's `<key>:` frontmatter line, or null when it has none. */
function frontmatterLine(
  text: string,
  key: FrontmatterKey,
): { line: number; value: string } | null {
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (front === undefined) return null;
  const rows = front.split("\n");
  const i = rows.findIndex((r) => r.startsWith(`${key}:`));
  if (i < 0) return null;
  return { line: i + 2, value: rows[i].slice(key.length + 1).trimStart() };
}

/** One inline `[ ... ]` list: the only frontmatter shape the gate accepts. */
const inlineList = (value: string) => /^\[.*\]$/.test(value);

/** Globs from one frontmatter list; `[]` when absent, empty or block-style. */
export function globsOf(text: string, key: FrontmatterKey): string[] {
  const value = frontmatterLine(text, key)?.value ?? "";
  if (!inlineList(value)) return [];
  return value.slice(1, -1).split(",").map((glob) => glob.trim().replace(/^["'`]|["'`]$/g, ""))
    .filter(Boolean);
}

/** `covers:`: the code the doc attests: a change without this doc is hard drift. */
export const coversOf = (text: string) => globsOf(text, "covers");

/** `watches:`: code the doc describes: a change here is a warning, never a failure. */
export const watchesOf = (text: string) => globsOf(text, "watches");

/** Docs reachable from `roots` by path or by basename mention. */
export function reachableDocs(texts: Map<string, string>, roots: string[]): Set<string> {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const counts = new Map<string, number>();
  for (const p of texts.keys()) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
  const needles = (p: string) => {
    const rel = p.replace(/^docs\//, "");
    // `rel` is unambiguous for a doc in a subdirectory; the two `README.md`
    // indexes share a basename, so those need their full path.
    const ns = [p];
    if (rel !== base(p)) ns.push(rel);
    if (counts.get(base(p)) === 1) ns.push(base(p));
    return ns;
  };
  const cites = (p: string, text: string) => needles(p).some((n) => text.includes(n));
  const reached = new Set([...texts.keys()].filter((p) => roots.some((t) => cites(p, t))));
  const queue = [...reached];
  while (queue.length) {
    const text = texts.get(queue.shift()!)!;
    for (const p of texts.keys()) {
      if (reached.has(p) || !cites(p, text)) continue;
      reached.add(p);
      queue.push(p);
    }
  }
  return reached;
}

async function walk(dir: string, root: string, out: Set<string>): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    const rel = relative(root, join(dir, e.name)).replaceAll("\\", "/");
    if (SKIP.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
    out.add(rel);
    if (e.isDirectory) await walk(join(dir, e.name), root, out);
  }
}

// `deno.json` is JSONC: drop `//` comments (never inside a string) so `tasks` parses.
const stripComments = (src: string) =>
  src.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (_, kept: string | undefined) => kept ?? "");

export async function checkDocs(root = "."): Promise<Violation[]> {
  const paths = new Set<string>();
  await walk(root, root, paths);
  const config = await Deno.readTextFile(join(root, "deno.json")).catch(() => "{}");
  const tasks = new Set(Object.keys(
    (JSON.parse(stripComments(config)) as {
      tasks?: Record<string, string>;
    }).tasks ?? {},
  ));
  const docs = [...paths].filter((p) => p.startsWith("docs/") && p.endsWith(".md")).sort();
  const skills = [...paths].filter((p) =>
    p.startsWith(".claude/skills/") && p.endsWith("/SKILL.md")
  );
  // A doc linked from a `.github/**/*.md` template is linked.
  const templates = [...paths].filter((p) => p.startsWith(".github/") && p.endsWith(".md"));
  const roots = [...ROOTS, ...skills, ...templates].filter((p) => paths.has(p));
  const exists = (p: string) =>
    paths.has(p) || GENERATED.some((g) => p === g || p.startsWith(`${g}/`)) ||
    (/[*{]/.test(p) && [...paths].some((q) => globToRegExp(p).test(q)));
  const found: Violation[] = [];
  const report = (
    file: string,
    hits: Hit[],
    kind: Violation["kind"],
    bad: (v: string) => boolean,
  ) => {
    for (const hit of hits) {
      if (bad(hit.value)) found.push({ file, line: hit.line, kind, detail: hit.value });
    }
  };

  for (const file of [...roots, ...docs]) {
    const text = await Deno.readTextFile(join(root, file));
    report(file, citedPaths(text), "dead path", (v) => !exists(v));
    report(file, markdownLinks(text), "broken link", (v) => {
      const target = resolves(file, v);
      return !!target && !exists(target);
    });
    report(file, citedTasks(text), "missing task", (v) => !tasks.has(v));
  }

  const texts = new Map<string, string>();
  for (const d of docs) texts.set(d, await Deno.readTextFile(join(root, d)));
  for (const d of docs) {
    const text = texts.get(d)!;
    for (const key of ["covers", "watches"] as const) {
      const row = frontmatterLine(text, key);
      if (!row) {
        if (key === "covers") {
          found.push({ file: d, line: 1, kind: "missing covers", detail: "covers:" });
        }
        continue;
      }
      if (!inlineList(row.value)) {
        found.push({
          file: d,
          line: row.line,
          kind: `bad ${key}`,
          detail: `${key}: must be one inline [ ... ] list`,
        });
      }
      for (const glob of globsOf(text, key)) {
        if (!exists(glob)) {
          found.push({ file: d, line: row.line, kind: `dead ${key}`, detail: glob });
        }
      }
    }
  }
  const reached = reachableDocs(
    texts,
    await Promise.all(roots.map((r) => Deno.readTextFile(join(root, r)))),
  );
  for (const d of docs) {
    if (!reached.has(d)) {
      found.push({ file: d, line: 1, kind: "orphan doc", detail: "not linked from a root doc" });
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return found.sort((a, b) => order(a.file, b.file) || a.line - b.line || order(a.kind, b.kind));
}

export const formatViolation = (v: Violation) => `${v.file}:${v.line}: ${v.kind}: ${v.detail}`;

if (import.meta.main) {
  const violations = await checkDocs(Deno.args[0] ?? ".");
  if (violations.length) {
    console.error(
      `Docs gate (#645): ${violations.length} violation(s)\n${
        violations.map(formatViolation).join("\n")
      }`,
    );
    Deno.exit(1);
  }
}
