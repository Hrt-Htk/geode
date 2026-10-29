// Gate-evidence check (#377): map changed paths to the CLAUDE.md §3 Done-table
// change classes, and fail a PR unless its body ticks every required gate.
//
// Also the docs drift hard check (#646): a changed file whose `covers:` doc did
// not change fails unless the PR body carries `docs: unaffected - <reason>`.
// A `watches:` match is printed as information and never fails.
//
// Pure helpers (importable, unit-tested):
//   requiredGates(changedPaths) -> the gate checklist the PR body must tick
//   tickedGates(body) / missingGates(body, required) -> checkbox parsing
//   driftFailure(drift, body) -> the docs-drift failure message, or null
//   docsDrift / docsOptOut (scripts/docs-drift.ts)
//
// CLI: reads the PR body from $GITHUB_EVENT_PATH and the changed paths from
// `git diff --name-only origin/main...HEAD`; exits 1 on any missing gate.
// Docs/chore-only changes require only the review item; `docs/` paths never trigger code gates.

import {
  docsDrift,
  docsOptOut,
  DRIFT_HINT,
  formatDrift,
  formatWarning,
  readDocGlobs,
} from "./docs-drift.ts";
import type { Drift } from "./docs-drift.ts";

const REVIEW_GATE = "Review pass";
const SYNC_GATES = [
  "Benchmark vault convergence",
  "Two-vault scenarios",
  "Hybrid phone E2E",
] as const;
const ADAPTER_GATES = ["On-device run"] as const;
const UI_GATES = ["Before/after screenshots"] as const;

const isSync = (p: string) =>
  p.startsWith("plugin/sync/") || /^core\/(reconciler|merge|apply|commit|chunker)/.test(p);
const isAdapter = (p: string) =>
  /^plugin\/plumbing\/(state|atomic-write|http-platform|key-cache)/.test(p) || /mobile/.test(p);
const isUi = (p: string) => p.startsWith("plugin/ui/") || p.endsWith("styles.css");

export function requiredGates(changedPaths: string[]): string[] {
  const gates = new Set<string>();
  for (const p of changedPaths) {
    if (p.startsWith("docs/")) continue;
    if (isSync(p)) SYNC_GATES.forEach((g) => gates.add(g));
    if (isAdapter(p)) ADAPTER_GATES.forEach((g) => gates.add(g));
    if (isUi(p)) UI_GATES.forEach((g) => gates.add(g));
  }
  return [...gates, REVIEW_GATE];
}

export function tickedGates(body: string): string[] {
  return [...body.matchAll(/^\s*-\s*\[[xX]\]\s*(.+?)\s*$/gm)].map((m) => m[1].trim());
}

export function missingGates(body: string, required: string[]): string[] {
  const ticked = tickedGates(body);
  return required.filter((r) =>
    !ticked.some((t) => t.startsWith(r) && /^(?:$|[\s:(-])/.test(t.slice(r.length)))
  );
}

/** Why the docs drift fails this PR, or null when there is none or the body opts out. */
export function driftFailure(drift: Drift[], body: string): string | null {
  if (!drift.length || docsOptOut(body)) return null;
  return `Docs drift: a changed file's doc was not updated:\n  ${
    drift.map(formatDrift).join("\n  ")
  }\n${DRIFT_HINT}`;
}

if (import.meta.main) {
  const eventPath = Deno.env.get("GITHUB_EVENT_PATH");
  if (!eventPath) {
    console.error("GITHUB_EVENT_PATH is not set: this check runs in the `Gate evidence` CI job.");
    Deno.exit(1);
  }
  const event = JSON.parse(await Deno.readTextFile(eventPath));
  const body = String(event.pull_request?.body ?? "");

  const changed = await changedPaths();
  const required = requiredGates(changed);
  const missing = missingGates(body, required);
  if (missing.length) {
    console.error(
      `Gate evidence missing: tick in the PR body:\n  ${
        missing.map((g) => `- [x] ${g}`).join("\n  ")
      }`,
    );
    Deno.exit(1);
  }

  const { drift, warnings, uncovered } = docsDrift(changed, await readDocGlobs());
  const failure = driftFailure(drift, body);
  if (failure) {
    console.error(failure);
    Deno.exit(1);
  }
  const info = warnings.length ? `\n${warnings.map(formatWarning).join("\n")}` : "";
  console.log(
    `Gate evidence OK (${changed.length} files): ${required.join(" · ")}` +
      `\nDocs drift OK (${uncovered.length} uncovered, ${warnings.length} watched)${info}`,
  );
}

async function changedPaths(): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["diff", "--name-only", "origin/main...HEAD"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    console.error(new TextDecoder().decode(out.stderr));
    Deno.exit(1);
  }
  return new TextDecoder().decode(out.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
}
