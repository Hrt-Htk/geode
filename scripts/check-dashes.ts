// Dash gate (#668): no U+2014 or U+2013 in a tracked file. The house style is
// a plain ASCII hyphen; a dash in prose or copy is rewritten, never swapped for
// another glyph. Every occurrence exits 1 as `file:line: kind`.
//
// Usage: `deno run -R --allow-run=git scripts/check-dashes.ts [root]`

export type Kind = "em dash" | "en dash";
export type Violation = { file: string; line: number; kind: Kind };

// The characters as escapes: this file is tracked, so it must pass its own gate.
const DASHES = new Map<string, Kind>([["\u2014", "em dash"], ["\u2013", "en dash"]]);

// Path prefixes that keep their dashes. The exemption is policy, not a secret,
// so it lives here in the diff instead of in an untracked file.
//   .claude/skills/obsidian/  the skill vendored unmodified from upstream
//                             (`.claude/skills/obsidian/VENDORED.md`): cleaning
//                             it breaks the re-copy refresh path, which brings
//                             its punctuation back.
export const ALLOWED = new Set([".claude/skills/obsidian/"]);

const LOCK = new Set(["deno.lock", "package-lock.json"]);

/** Dash hits over already-read files. */
export function scan(files: Array<{ path: string; text: string }>): Violation[] {
  const found: Violation[] = [];
  for (const { path, text } of files) {
    if ([...ALLOWED].some((prefix) => path.startsWith(prefix))) continue;
    for (const [i, line] of text.split("\n").entries()) {
      for (const ch of line) {
        const kind = DASHES.get(ch);
        if (kind) found.push({ file: path, line: i + 1, kind });
      }
    }
  }
  return found;
}

/** Tracked text files under `root`, binaries and lock files dropped. */
async function tracked(root: string): Promise<Array<{ path: string; text: string }>> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const list = new TextDecoder().decode(out.stdout).split("\0").filter(Boolean);
  const files = [];
  for (const path of list) {
    if (LOCK.has(path)) continue;
    const bytes = await Deno.readFile(`${root}/${path}`).catch(() => null);
    if (bytes == null || bytes.includes(0)) continue;
    files.push({ path, text: new TextDecoder().decode(bytes) });
  }
  return files;
}

export async function checkDashes(root = ".") {
  return scan(await tracked(root));
}

export const formatViolation = (v: Violation) => `${v.file}:${v.line}: ${v.kind}`;

if (import.meta.main) {
  const violations = await checkDashes(Deno.args[0] ?? ".");
  if (violations.length) {
    console.error(
      `Dash gate (#668): ${violations.length} hit(s) in tracked files\n${
        violations.map(formatViolation).join("\n")
      }`,
    );
    Deno.exit(1);
  }
}
