#!/usr/bin/env node
// Geode commit gate (PreToolUse on Bash). Blocks `git commit` when staged files
// violate a deterministic hard rule: the Rule 5 LOC tripwire, the console.log
// ban, or a UI change without a fresh screenshot. Exit 2 + stderr = block (fed
// back to the agent). Also warns (never blocks) on docs drift for the commands
// that ship a branch.
import fs from "node:fs";
import { execSync } from "node:child_process";

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd = input?.tool_input?.command || "";

// Docs drift: warn only. A covered file changed without its doc is cheaper to
// fix here than to read about from the Gate evidence job.
if (/\bgit\s+(commit|push)\b|\bgh\s+pr\s+create\b/.test(cmd)) {
  try {
    execSync("deno task --quiet docs:drift", { stdio: ["ignore", "ignore", 2], timeout: 20_000 });
  } catch { /* warn only */ }
}

if (!/\bgit\s+commit\b/.test(cmd)) process.exit(0);

let staged = [];
try {
  staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
} catch {
  process.exit(0);
}
if (!staged.length) process.exit(0);

const errs = [];

// 1. Rule 5 size tripwire: server/ <=300, core/ and plugin/ <=500 code lines per
//    file. Reuses scripts/check-loc.ts, so the hook and `deno task standards`
//    count the same thing (code lines, not raw lines).
try {
  execSync("deno run -R scripts/check-loc.ts", {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 60_000,
  });
} catch (e) {
  const out = String(e?.stderr ?? "");
  if (out.includes("LOC tripwire")) errs.push(out.trim());
}

// 2. console.log ban outside */log.ts (CLAUDE.md Work section).
for (const f of staged) {
  if (
    /\.ts$/.test(f) && !/log\.ts$/.test(f) && /^(plugin|server|core)\//.test(f) && fs.existsSync(f)
  ) {
    if (/\bconsole\.log\s*\(/.test(fs.readFileSync(f, "utf8"))) {
      errs.push(`console.log ban: ${f} has console.log: use the structured logger (*/log.ts).`);
    }
  }
}

// 3. UI-change screenshot gate (CLAUDE.md "3 · Done", UI row). Evidence = a PNG
//    in the main checkout's tmp/review/ updated in the last 30 min.
//    Override: GEODE_SKIP_UI_GATE=1.
const uiChanged = staged.some((f) => /^plugin\/ui\//.test(f) || f === "plugin/manifest/styles.css");
if (uiChanged && !process.env.GEODE_SKIP_UI_GATE) {
  let fresh = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.png$/.test(e.name) && Date.now() - fs.statSync(p).mtimeMs < 30 * 60 * 1000) {
        fresh = true;
      }
    }
  };
  // Review evidence lives in the main checkout, not the worktree: a worktree's
  // tmp/ is deleted when the workspace is archived.
  let reviewDir = "tmp/review";
  try {
    const common = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      encoding: "utf8",
    });
    reviewDir = `${common.trim().replace(/[\\/]\.git$/, "")}/tmp/review`;
  } catch { /* no git: keep the cwd-relative path */ }
  try {
    if (fs.existsSync(reviewDir)) walk(reviewDir);
  } catch { /* ignore */ }
  if (!fresh) {
    errs.push(
      "UI gate: UI files changed but no screenshot under tmp/review/ (main checkout) updated in " +
        "the last 30 min. Render and READ the PNG via the geode-ui loop, or set " +
        "GEODE_SKIP_UI_GATE=1 to override.",
    );
  }
}

if (errs.length) {
  process.stderr.write("⛔ Geode commit gate blocked this commit:\n- " + errs.join("\n- ") + "\n");
  process.exit(2);
}
process.exit(0);
