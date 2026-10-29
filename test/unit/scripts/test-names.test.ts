// The test-file naming rule (#648): names describe behavior, never an issue
// number: `gateN-` prefixes survive only as step-gate evidence cited in
// docs/testing/step-gates.md.

import { assertEquals } from "@std/assert";
import { testNameViolations } from "../../../scripts/standards.ts";

const DOC = [
  "- `test/e2e/scenarios/gate4-plugin-loads.spec.ts`: plugin loads",
  "- `test/e2e/scenarios/gate10-trash-restore.spec.ts`: delete → trash → restore",
].join("\n");

const clean = (paths: string[], doc = DOC) => assertEquals(testNameViolations(paths, doc), []);

Deno.test("test names: kebab-case test/spec files and non-test files pass", () => {
  clean([
    "test/unit/plugin/ws-hub.test.ts",
    "test/e2e/scenarios/device-name.spec.ts",
    "test/e2e/scenarios/device-name.phone.spec.ts",
    "test/e2e/scenarios/rekey-elsewhere.hybrid.spec.ts",
    "test/e2e/scenarios/gate4-plugin-loads.spec.ts",
    "test/e2e/scenarios/gate10-trash-restore.hybrid.spec.ts",
    "test/README.md",
    "test/two-vault-driver.ts",
    "test/e2e/helpers/waits.ts",
    "test/e2e/helpers/rekey.deno.ts",
  ]);
});

Deno.test("test names: underscores and capitals break kebab-case", () => {
  assertEquals(testNameViolations(["test/unit/plugin/ws_hub.test.ts"], DOC), [
    "test/unit/plugin/ws_hub.test.ts:kebab-case",
  ]);
  assertEquals(testNameViolations(["test/e2e/scenarios/DeviceName.spec.ts"], DOC), [
    "test/e2e/scenarios/DeviceName.spec.ts:kebab-case",
  ]);
});

Deno.test("test names: issue numbers in file names are violations", () => {
  for (
    const path of [
      "test/e2e/scenarios/issue999-foo.spec.ts",
      "test/unit/plugin/issue12-flush.test.ts",
      "test/scenarios/sync/issue-12-flush.test.ts",
      "test/scenarios/sync/merge-issue7-carry.test.ts",
      "test/e2e/scenarios/gate437-old-gate.spec.ts",
      "test/e2e/scenarios/gate-foo.spec.ts",
    ]
  ) {
    assertEquals(testNameViolations([path], DOC), [`${path}:issue-number`], path);
  }
});

Deno.test("test names: gateN- survives only when it is step-gate evidence", () => {
  assertEquals(testNameViolations(["test/e2e/scenarios/gate4-plugin-loads.spec.ts"], ""), [
    "test/e2e/scenarios/gate4-plugin-loads.spec.ts:gate-not-evidence",
  ]);
  assertEquals(testNameViolations(["test/e2e/scenarios/gate11-onboarding.spec.ts"], DOC), [
    "test/e2e/scenarios/gate11-onboarding.spec.ts:gate-not-evidence",
  ]);
  assertEquals(testNameViolations(["test/e2e/scenarios/gate12-late-gate.spec.ts"], DOC), [
    "test/e2e/scenarios/gate12-late-gate.spec.ts:issue-number",
  ]);
  clean(["test/e2e/scenarios/gate10-trash-restore.phone.spec.ts"]);
});
