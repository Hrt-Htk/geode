#!/usr/bin/env node
// Geode branch pre-flight (PreToolUse on Edit/Write/MultiEdit). Blocks edits to
// source logic on `main` (CLAUDE.md pre-flight: work on a type/issueN branch).
// Exempts version/metadata files so releases can bump on main. Exit 2 = block.
import fs from "node:fs";
import { execSync } from "node:child_process";

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const fp = (input?.tool_input?.file_path || "").replace(/\\/g, "/");
if (!fp) process.exit(0);

const inSrc = /(^|\/)(server|core|db|test)\//.test(fp) || /(^|\/)plugin\//.test(fp);
const exempt = /(manifest\.json|versions\.json|package\.json)$/.test(fp);
if (!inSrc || exempt) process.exit(0);

let branch = "";
const cwd = fp.slice(0, fp.lastIndexOf("/")) || ".";
try {
  branch = execSync("git branch --show-current", { cwd, encoding: "utf8" }).trim();
} catch {
  process.exit(0);
}
if (branch === "main") {
  process.stderr.write(
    `⛔ Geode pre-flight: editing ${fp} on \`main\`. Create a branch first ` +
      "(git checkout -b type/issueN-desc): CLAUDE.md forbids source edits on main.\n",
  );
  process.exit(2);
}
process.exit(0);
