// Repo health report (#392): review candidates, near-limit files, duplication
// and 90-day churn. Reuses the standards baseline (standards.ts), the LOC logic
// (check-loc.ts) and the docs gate (check-docs.ts), and prints a markdown report
// to stdout.
//
// Usage: `deno task health`

import { readBaseline } from "./standards.ts";
import { LIMITS, type Loc, locStats, REVIEW_AT } from "./check-loc.ts";
import { checkDocs, formatViolation, type Violation } from "./check-docs.ts";

const NEAR: Record<string, number> = {
  server: LIMITS.server - 30,
  core: LIMITS.core - 50,
  plugin: LIMITS.plugin - 50,
};
const DAYS = "90.days";

type Churn = { added: number; deleted: number; commits: Set<string> };

const run = (cmd: string, args: string[]): string => {
  const out = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).outputSync();
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
};

// 90-day churn per path: added/deleted lines + distinct commits.
function churn90(): Map<string, Churn> {
  const map = new Map<string, Churn>();
  let commit = "";
  for (
    const line of run("git", ["log", `--since=${DAYS}`, "--pretty=format:%H", "--numstat"]).split(
      "\n",
    )
  ) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m || m[1] === "-" || m[2] === "-") continue;
    const e = map.get(m[3]) ?? { added: 0, deleted: 0, commits: new Set<string>() };
    e.added += Number(m[1]);
    e.deleted += Number(m[2]);
    e.commits.add(commit);
    map.set(m[3], e);
  }
  return map;
}

// Duplication % from jscpd's JSON reporter (statistics.total.percentage).
function dupPct(root: string): number {
  const outDir = `${root}/tmp/jscpd-health`;
  run("node_modules/.bin/jscpd", [
    "--config",
    ".jscpd.json",
    "--reporters",
    "json",
    "--output",
    outDir,
  ]);
  const report = JSON.parse(Deno.readTextFileSync(`${outDir}/jscpd-report.json`));
  return report.statistics.total.percentage;
}

function render({
  sha,
  branch,
  ts,
  baseline,
  candidates,
  near,
  hotspots,
  lines,
  churn,
  pct,
  docs,
}: {
  sha: string;
  branch: string;
  ts: Date;
  baseline: Record<string, Record<string, number>>;
  candidates: Loc[];
  near: Loc[];
  hotspots: [string, Churn][];
  lines: Map<string, number>;
  churn: Map<string, Churn>;
  pct: number;
  docs: Violation[];
}): string {
  const rows = (files: Loc[]) =>
    files.map((f) => `| ${f.path} | ${f.lines} | ${churnFor(f.path, churn)} |`).join("\n");
  return [
    "# Repo health",
    "",
    `- commit: \`${sha}\` (\`${branch}\`)`,
    `- generated: ${ts.toISOString()}`,
    "",
    "## Standards baseline (per check)",
    "",
    ...(Object.keys(baseline).length
      ? [
        "| check | baseline |",
        "|---|---|",
        ...Object.entries(baseline).map(
          ([k, v]) => `| ${k} | ${Object.values(v).reduce((a, b) => a + b, 0)} |`,
        ),
      ]
      : ["clean"]),
    "",
    "## Docs gate (#645)",
    "",
    docs.length ? docs.map((v) => `- ${formatViolation(v)}`).join("\n") : "clean",
    "",
    "## Review candidates (core/plugin >300 code lines)",
    "",
    candidates.length
      ? "| file | code lines | 90-day churn (added/deleted, commits) |\n|---|---|---|\n" +
        rows(candidates)
      : "none",
    "",
    "## Near limit",
    "",
    near.length
      ? "| file | code lines | limit |\n|---|---|---|\n" +
        near.map((f) => `| ${f.path} | ${f.lines} | ${LIMITS[f.dir]} |`).join("\n")
      : "none",
    "",
    "## Duplication",
    "",
    `- jscpd: ${pct.toFixed(2)}%`,
    "",
    "## Top 10 hotspots (90-day churn)",
    "",
    hotspots.length
      ? "| file | code lines | added | deleted | commits |\n|---|---|---|---|---|\n" +
        hotspots.map(([p, c]) =>
          `| ${p} | ${lines.get(p)} | ${c.added} | ${c.deleted} | ${c.commits.size} |`
        ).join("\n")
      : "none",
    "",
  ].join("\n");
}

// Churn cell for a file: "+added -deleted (N commits)", or "-" if no commits
// in the window.
function churnFor(path: string, churn: Map<string, Churn>): string {
  const c = churn.get(path);
  return c ? `+${c.added} -${c.deleted} (${c.commits.size})` : "-";
}

if (import.meta.main) {
  const root = Deno.cwd();
  const [sha, branch] = [
    run("git", ["rev-parse", "--short", "HEAD"]),
    run("git", ["branch", "--show-current"]),
  ]
    .map((s) => s.trim());
  const files = await locStats(root);
  const lines = new Map(files.map((f) => [f.path, f.lines]));
  const candidates = files.filter((f) => f.dir !== "server" && f.lines > REVIEW_AT);
  const near = files.filter((f) => f.lines > NEAR[f.dir] && f.lines <= LIMITS[f.dir]);
  const churn = churn90();
  const hotspots = [...churn.entries()]
    .filter(([p]) => lines.has(p))
    .sort((a, b) => b[1].added + b[1].deleted - (a[1].added + a[1].deleted))
    .slice(0, 10);

  console.log(render({
    sha,
    branch,
    ts: new Date(),
    baseline: await readBaseline(),
    candidates,
    near,
    hotspots,
    lines,
    churn,
    pct: dupPct(root),
    docs: await checkDocs(root),
  }));
}
