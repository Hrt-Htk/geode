// Unit tests for the gate-evidence check (#377): `requiredGates` maps changed
// paths to the CLAUDE.md §3 Done-table gates; `tickedGates`/`missingGates`
// parse the PR-body checkboxes.

import { assertEquals } from "@std/assert";
import {
  driftFailure,
  missingGates,
  requiredGates,
  tickedGates,
} from "../../../scripts/check-gate-evidence.ts";
import { DRIFT_HINT, formatDrift } from "../../../scripts/docs-drift.ts";

const SYNC = [
  "Benchmark vault convergence",
  "Two-vault scenarios",
  "Hybrid phone E2E",
  "Review pass",
];
const ADAPTER = ["On-device run", "Review pass"];
const UI = ["Before/after screenshots", "Review pass"];

Deno.test("sync-affecting paths require the sync gates plus review", () => {
  assertEquals(requiredGates(["plugin/sync/transport.ts"]), SYNC);
  assertEquals(requiredGates(["core/chunker.ts"]), SYNC);
  assertEquals(requiredGates(["plugin/sync/merger.ts", "plugin/sync/commit.ts"]), SYNC);
});

Deno.test("adapter/mobile/state paths require an on-device run", () => {
  assertEquals(requiredGates(["plugin/plumbing/state-persistence.ts"]), ADAPTER);
  assertEquals(requiredGates(["plugin/plumbing/atomic-write.ts"]), ADAPTER);
});

Deno.test("docs paths never trigger code gates (#467)", () => {
  assertEquals(
    requiredGates([
      "docs/design/pages/issue-451-icons-mobile.md",
      "docs/design/styles.css",
      "docs/design/main.js",
    ]),
    ["Review pass"],
  );
});

Deno.test("UI paths require screenshots", () => {
  assertEquals(requiredGates(["plugin/ui/settings-tab.ts"]), UI);
  assertEquals(requiredGates(["plugin/ui/statusbar.ts", "plugin/ui/passphrase-modal.ts"]), UI);
  assertEquals(requiredGates(["plugin/manifest/styles.css"]), UI);
});

Deno.test("docs/chore-only paths require only the review pass", () => {
  assertEquals(
    requiredGates(["docs/dev/workflow.md", "CLAUDE.md", ".github/workflows/ci.yml"]),
    ["Review pass"],
  );
  assertEquals(requiredGates(["server/routes.ts"]), ["Review pass"]);
});

Deno.test("tickedGates parses ticked checkboxes only", () => {
  const body = [
    "- [x] Benchmark vault convergence",
    "- [ ] Two-vault scenarios",
    "- [X] Review pass: done",
    "plain text",
  ].join("\n");
  assertEquals(tickedGates(body), ["Benchmark vault convergence", "Review pass: done"]);
});

Deno.test("missingGates flags unticked required gates", () => {
  const body = "- [x] Review pass\n- [ ] Benchmark vault convergence\n";
  assertEquals(missingGates(body, SYNC), [
    "Benchmark vault convergence",
    "Two-vault scenarios",
    "Hybrid phone E2E",
  ]);
  assertEquals(missingGates("- [x] Review pass: done", ["Review pass"]), []);
});

Deno.test("missingGates accepts any separator after a ticked label, not a longer word", () => {
  const body = [
    "- [x] Hybrid phone E2E: 21 passed",
    "- [x] Two-vault scenarios (117 passed)",
    "- [x] Benchmark vault convergence - 3 PASS",
    "- [x] Review passes",
  ].join("\n");
  assertEquals(
    missingGates(body, [
      "Hybrid phone E2E",
      "Two-vault scenarios",
      "Benchmark vault convergence",
      "Review pass",
    ]),
    ["Review pass"],
  );
});

const DRIFT = [{ file: "core/chunker.ts", docs: ["docs/crypto/encryption-chunking.md"] }];

Deno.test("driftFailure: a branch with no drift passes", () => {
  assertEquals(driftFailure([], ""), null);
});

Deno.test("driftFailure: drift fails, naming the file and quoting the hint", () => {
  const msg = driftFailure(DRIFT, "- [x] Review pass\n")!;
  assertEquals(msg.includes(formatDrift(DRIFT[0])), true);
  assertEquals(msg.includes(DRIFT_HINT), true);
});

Deno.test("driftFailure: the PR-body opt-out clears drift, a bogus one does not", () => {
  assertEquals(driftFailure(DRIFT, "docs: unaffected - comment only"), null);
  assertEquals(driftFailure(DRIFT, "docs: unaffected -") !== null, true);
  assertEquals(driftFailure(DRIFT, "docs: unaffected - <reason>") !== null, true);
});
