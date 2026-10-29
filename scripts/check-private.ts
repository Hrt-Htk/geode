// Private-data gate (#642): the repo is public, so a personal value must not
// come back into a tracked file.
//
// Two layers, both reported as `file:line: kind: match`, any hit exits 1:
//   in the repo   generic shapes: private IPv4 (RFC 1918 + CGNAT/Tailscale),
//                 `*.ts.net` hosts, the Tailscale IPv6 ULA prefix,
//                 `/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\`. RFC 5737
//                 documentation ranges, loopback and `0.0.0.0` pass.
//   local only    GEODE_PRIVATE_DENYLIST names an untracked file (a leading `~/`
//                 resolves against HOME) whose every non-comment line is a
//                 forbidden case-insensitive substring. Hits print `denylist
//                 entry #N` (N = its line) and never the value: CI logs must not
//                 leak what they protect. Set but unreadable or empty is a
//                 misconfiguration and exits 1 rather than switching off.
//
// Usage: `deno run -R -E --allow-run=git --env-file=.env.local scripts/check-private.ts [root]`

export type Kind =
  | "private ipv4"
  | "tailscale host"
  | "tailscale ipv6"
  | "home path"
  | "denylist";
export type Violation = { file: string; line: number; kind: Kind; detail: string };
export type DenylistEntry = { entry: string; line: number };

// Exact addresses that are fixtures, not leaks, each allowed only in the file
// that needs it. Nothing else may be added: an entry here exempts it once.
const ALLOWED: Record<string, string> = {
  "192.168.1.20": "README.md", // home-network example: the doc must show a LAN address
  // httpBase LAN heuristic fixture: the address must be private
  "192.168.1.5": "test/integration/provisioning-client.test.ts",
};

// Private IPv4: 10/8, 172.16/12, 192.168/16, 100.64/10.
const IPV4 =
  /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g;
const TS_NET = /\b[a-z0-9][a-z0-9.-]*\.ts\.net\b/gi;
// Tailscale's IPv6 ULA prefix: `fd7a:115c:a1e0::/48`.
const TS_ULA = /fd7a:115c:a1e0:/gi;
const HOME = /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])[A-Za-z0-9._-]+[\\/]/gi;
// Placeholder names: a doc may write `/home/you/` or `/Users/Shared/`.
const GENERIC_HOME =
  /^(?:\/home|[A-Za-z]:[\\/]Users)[\\/](?:user|you)[\\/]$|^\/Users\/(?:user|you|Shared)\/$/i;

// The patterns above and their test must contain literal addresses, so the
// pattern layer skips them (the denylist layer still covers both).
const SELF = new Set(["scripts/check-private.ts", "test/unit/scripts/check-private.test.ts"]);

const RULES: Array<{ kind: Kind; find: RegExp; skip?: RegExp }> = [
  { kind: "private ipv4", find: IPV4 },
  { kind: "tailscale host", find: TS_NET },
  { kind: "tailscale ipv6", find: TS_ULA },
  { kind: "home path", find: HOME, skip: GENERIC_HOME },
];

const LOCK = new Set(["deno.lock", "package-lock.json"]);

/** Pattern and denylist hits over already-read files. */
export function scan(files: Array<{ path: string; text: string }>, entries: DenylistEntry[]) {
  const found: Violation[] = [];
  for (const { path, text } of files) {
    const rules = SELF.has(path) ? [] : RULES;
    for (const [i, line] of text.split("\n").entries()) {
      const seen = new Set<string>();
      for (const rule of rules) {
        for (const m of line.matchAll(rule.find)) {
          const match = m[0];
          if (ALLOWED[match] === path || rule.skip?.test(match) || seen.has(rule.kind + match)) {
            continue;
          }
          seen.add(rule.kind + match);
          found.push({ file: path, line: i + 1, kind: rule.kind, detail: match });
        }
      }
      const lower = line.toLowerCase();
      for (const e of entries) {
        if (lower.includes(e.entry.toLowerCase())) {
          found.push({
            file: path,
            line: i + 1,
            kind: "denylist",
            detail: `denylist entry #${e.line}`,
          });
        }
      }
    }
  }
  return found;
}

export async function readDenylist(path: string | undefined): Promise<DenylistEntry[]> {
  if (!path) return [];
  const home = Deno.env.get("HOME") ?? "";
  const raw = await Deno.readTextFile(path.replace(/^~\//, `${home}/`)).catch(() => null);
  const entries = raw == null ? [] : raw.split("\n").flatMap((line, i) => {
    const entry = line.trim();
    return entry && !entry.startsWith("#") ? [{ entry, line: i + 1 }] : [];
  });
  // Set but unusable is a misconfigured local layer, not a disabled one.
  if (entries.length === 0) throw new Error("denylist set but unreadable or empty");
  return entries;
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

export async function checkPrivate(root = ".", entries: DenylistEntry[] = []) {
  return scan(await tracked(root), entries);
}

export const formatViolation = (v: Violation) => `${v.file}:${v.line}: ${v.kind}: ${v.detail}`;

if (import.meta.main) {
  const entries = await readDenylist(Deno.env.get("GEODE_PRIVATE_DENYLIST")).catch((e) => {
    console.error(e.message);
    Deno.exit(1);
  });
  const violations = await checkPrivate(Deno.args[0] ?? ".", entries);
  if (violations.length) {
    console.error(
      `Private-data gate (#642): ${violations.length} hit(s) in tracked files\n${
        violations.map(formatViolation).join("\n")
      }`,
    );
    Deno.exit(1);
  }
}
