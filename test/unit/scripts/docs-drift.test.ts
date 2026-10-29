// Unit tests for the docs drift check (#646): a changed file is drift when a
// doc's `covers:` globs match it and none of those docs changed on the branch
// (hard); a file only a doc's `watches:` globs match is a warning (never fails);
// a matched-by-nothing file is uncovered (informational). The PR-body opt-out
// (`docs: unaffected - <reason>`) is what the CI hard check accepts instead.

import { assertEquals } from "@std/assert";
import {
  docsDrift,
  docsOptOut,
  DRIFT_HINT,
  formatDrift,
  formatWarning,
  readDocGlobs,
} from "../../../scripts/docs-drift.ts";

const doc = (name: string, covers: string[], watches: string[] = []) => ({
  doc: name,
  covers,
  watches,
});
const CRYPTO = doc("docs/crypto/encryption-chunking.md", ["core/*.ts"]);

Deno.test("docsDrift: a covered file changed without its doc is drift", () => {
  assertEquals(docsDrift(["core/chunker.ts"], [CRYPTO]), {
    drift: [{ file: "core/chunker.ts", docs: ["docs/crypto/encryption-chunking.md"] }],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: the covering doc touched in the branch clears its files", () => {
  assertEquals(
    docsDrift(["core/chunker.ts", "docs/crypto/encryption-chunking.md"], [CRYPTO]),
    { drift: [], warnings: [], uncovered: [] },
  );
});

Deno.test("docsDrift: any one of several covering docs clears the file", () => {
  const docs = [CRYPTO, doc("docs/architecture/plugin.md", ["core/*.ts"])];
  assertEquals(docsDrift(["core/chunker.ts", "docs/architecture/plugin.md"], docs), {
    drift: [],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: drift names every covering doc, in covers order", () => {
  const docs = [CRYPTO, doc("docs/architecture/server.md", ["core/*.ts"])];
  assertEquals(docsDrift(["core/chunker.ts"], docs).drift, [{
    file: "core/chunker.ts",
    docs: ["docs/crypto/encryption-chunking.md", "docs/architecture/server.md"],
  }]);
});

Deno.test("docsDrift: markdown itself is neither drift nor uncovered", () => {
  assertEquals(docsDrift(["docs/dev/workflow.md", "CLAUDE.md", "plugin/README.md"], [CRYPTO]), {
    drift: [],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: a file no doc attests is uncovered only", () => {
  assertEquals(docsDrift(["scripts/release.ts", "core/chunker.ts"], [CRYPTO]), {
    drift: [{ file: "core/chunker.ts", docs: ["docs/crypto/encryption-chunking.md"] }],
    warnings: [],
    uncovered: ["scripts/release.ts"],
  });
});

Deno.test("docsDrift: ** spans directories, * stays inside one", () => {
  const docs = [doc("docs/testing/strategy.md", ["test/scenarios/**"])];
  assertEquals(
    docsDrift(["test/scenarios/sync/initial-sync.test.ts"], docs).drift,
    [{ file: "test/scenarios/sync/initial-sync.test.ts", docs: ["docs/testing/strategy.md"] }],
  );
  const flat = [doc("docs/x.md", ["core/*.ts"])];
  assertEquals(docsDrift(["core/nested/x.ts"], flat).uncovered, ["core/nested/x.ts"]);
});

Deno.test("docsDrift: a file listed twice reports once, sorted", () => {
  assertEquals(docsDrift(["core/chunker.ts", "core/chunker.ts", "core/hash.ts"], [CRYPTO]), {
    drift: [
      { file: "core/chunker.ts", docs: ["docs/crypto/encryption-chunking.md"] },
      { file: "core/hash.ts", docs: ["docs/crypto/encryption-chunking.md"] },
    ],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: a watches-only file is a warning, never drift", () => {
  const gates = doc("docs/testing/step-gates.md", ["test/e2e/scenarios/gate*.spec.ts"], [
    "test/scenarios/**",
  ]);
  assertEquals(docsDrift(["test/scenarios/sync/basic.test.ts"], [gates]), {
    drift: [],
    warnings: [{ file: "test/scenarios/sync/basic.test.ts", docs: ["docs/testing/step-gates.md"] }],
    uncovered: [],
  });
});

Deno.test("docsDrift: the watching doc touched in the branch clears the warning", () => {
  const gates = doc("docs/testing/step-gates.md", [], ["test/scenarios/**"]);
  assertEquals(
    docsDrift(["test/scenarios/a.test.ts", "docs/testing/step-gates.md"], [gates]),
    { drift: [], warnings: [], uncovered: [] },
  );
});

Deno.test("docsDrift: a covered file is never also warned about", () => {
  const docs = [
    doc("docs/testing/strategy.md", ["test/two-vault-driver.ts"]),
    doc("docs/testing/step-gates.md", [], ["test/two-vault-driver.ts"]),
  ];
  assertEquals(docsDrift(["test/two-vault-driver.ts"], docs), {
    drift: [{ file: "test/two-vault-driver.ts", docs: ["docs/testing/strategy.md"] }],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: only the watching doc changed leaves the covering doc's drift", () => {
  const docs = [
    doc("docs/testing/strategy.md", ["test/two-vault-driver.ts"]),
    doc("docs/testing/step-gates.md", [], ["test/two-vault-driver.ts"]),
  ];
  assertEquals(docsDrift(["test/two-vault-driver.ts", "docs/testing/step-gates.md"], docs), {
    drift: [{ file: "test/two-vault-driver.ts", docs: ["docs/testing/strategy.md"] }],
    warnings: [],
    uncovered: [],
  });
});

Deno.test("docsDrift: a warning names every watching doc, in docs order", () => {
  const docs = [
    doc("docs/testing/step-gates.md", [], ["test/scenarios/**"]),
    doc("docs/testing/strategy.md", [], ["test/scenarios/**"]),
  ];
  assertEquals(docsDrift(["test/scenarios/a.test.ts"], docs).warnings, [{
    file: "test/scenarios/a.test.ts",
    docs: ["docs/testing/step-gates.md", "docs/testing/strategy.md"],
  }]);
});

Deno.test("formatDrift: the line the CLI, the hook and CI print", () => {
  assertEquals(
    formatDrift({ file: "core/chunker.ts", docs: ["docs/crypto/encryption-chunking.md"] }),
    "docs drift: core/chunker.ts changed, covered by docs/crypto/encryption-chunking.md " +
      "(not touched in this branch)",
  );
});

Deno.test("formatWarning: names the doc to check, not an opt-out", () => {
  assertEquals(
    formatWarning({ file: "test/scenarios/a.test.ts", docs: ["docs/testing/step-gates.md"] }),
    "docs check: test/scenarios/a.test.ts changed, see docs/testing/step-gates.md",
  );
});

Deno.test("DRIFT_HINT names the opt-out line", () => {
  assertEquals(
    DRIFT_HINT,
    `Update the doc, or add "docs: unaffected - <reason>" to the PR body.`,
  );
});

Deno.test("docsOptOut: a plain hyphen and a non-empty reason opt out", () => {
  assertEquals(docsOptOut("docs: unaffected - comment only"), true);
  assertEquals(docsOptOut("- [x] Review pass\n\n  docs:  unaffected - comment only\n"), true);
});

Deno.test("docsOptOut: an em or en dash does not opt out, an empty reason does not", () => {
  assertEquals(docsOptOut("docs: unaffected \u2013 comment only"), false);
  assertEquals(docsOptOut("docs: unaffected \u2014 comment only"), false);
  assertEquals(docsOptOut("docs: unaffected -"), false);
  assertEquals(docsOptOut("docs: unaffected -   "), false);
  assertEquals(docsOptOut("docs unaffected - comment only"), false);
  assertEquals(docsOptOut("no opt-out here"), false);
});

Deno.test("docsOptOut: the <reason> placeholder is not an opt-out", () => {
  assertEquals(docsOptOut("docs: unaffected - <reason>"), false);
  assertEquals(docsOptOut("docs: unaffected - <reason> because x"), false);
  assertEquals(docsOptOut("docs: unaffected - reason only"), true);
});

Deno.test("readDocGlobs: every doc under the directory, nested included", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/nested`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/a.md`,
    "---\ncovers: [core/*.ts]\nwatches: [test/**/*.ts]\n---\n\n# A\n",
  );
  await Deno.writeTextFile(`${root}/docs/nested/b.md`, "---\ncovers: []\n---\n\n# B\n");
  try {
    assertEquals(await readDocGlobs(`${root}/docs`), [
      { doc: `${root}/docs/a.md`, covers: ["core/*.ts"], watches: ["test/**/*.ts"] },
      { doc: `${root}/docs/nested/b.md`, covers: [], watches: [] },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
