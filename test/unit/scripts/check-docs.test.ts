// Unit tests for the docs gate (#645): cited repo paths, relative markdown
// links, `deno task` names, glob expansion, orphan reachability under `docs/`
// and the `covers:` frontmatter the drift check (#646) reads. `checkDocs` runs
// the whole gate against a throwaway fixture root so every violation kind is
// covered end to end, and `formatViolation` pins the `file:line: kind,
// detail` line the CLI and the health report print.

import { assertEquals } from "@std/assert";
import {
  checkDocs,
  citedPaths,
  citedTasks,
  coversOf,
  formatViolation,
  globToRegExp,
  markdownLinks,
  reachableDocs,
  resolves,
  watchesOf,
} from "../../../scripts/check-docs.ts";

/** A doc with `covers:` frontmatter; body violations land on line 4 and below. */
const doc = (covers: string, body: string, watches?: string) =>
  `---\ncovers: ${covers}\n${watches ? `watches: ${watches}\n` : ""}---\n${body}`;

Deno.test("citedPaths: inline code spans only, prose is not a citation", () => {
  assertEquals(citedPaths("see `server/main.ts`\na plain plugin/server mention"), [
    { line: 1, value: "server/main.ts" },
  ]);
});

Deno.test("citedPaths: drops line refs, trailing dots, dir slashes and non-repo code", () => {
  assertEquals(
    citedPaths("`server/routes.ts:145` `core/` `docs/README.md.` `@db/sqlite` `deno task ci`"),
    [
      { line: 1, value: "server/routes.ts" },
      { line: 1, value: "core" },
      { line: 1, value: "docs/README.md" },
    ],
  );
});

Deno.test("citedPaths: globs and placeholders survive extraction", () => {
  assertEquals(citedPaths("`core/*.ts` `test/e2e/scenarios/<file>.spec.ts`"), [
    { line: 1, value: "core/*.ts" },
    { line: 1, value: "test/e2e/scenarios" },
  ]);
});

Deno.test("citedPaths: fence content is scanned, tagged or not", () => {
  const text = [
    "```bash",
    "sudo bash deploy/install.sh",
    "```",
    "```",
    "plugin/sync/reconciler.ts",
    "```",
  ].join("\n");
  assertEquals(citedPaths(text), [
    { line: 2, value: "deploy/install.sh" },
    { line: 5, value: "plugin/sync/reconciler.ts" },
  ]);
});

Deno.test("citedPaths: ~ fences, and only a fence of the same char and length closes", () => {
  const text = [
    "~~~",
    "server/main.ts",
    "~~~",
    "````md",
    "```",
    "core/chunker.ts",
    "```",
    "````",
    "`docs/README.md`",
  ].join("\n");
  assertEquals(citedPaths(text), [
    { line: 2, value: "server/main.ts" },
    { line: 6, value: "core/chunker.ts" },
    { line: 9, value: "docs/README.md" },
  ]);
});

Deno.test("citedPaths: a scheme prefix is not a repo path", () => {
  assertEquals(citedPaths("`npm:core/x` `core/x.ts`"), [{ line: 1, value: "core/x.ts" }]);
});

Deno.test("markdownLinks: targets with line numbers, fenced blocks skipped", () => {
  const text = ["[a](../README.md)", "```", "[b](../nope.md)", "```"].join("\n");
  assertEquals(markdownLinks(text), [{ line: 1, value: "../README.md" }]);
});

Deno.test("resolves: relative targets, external and anchors dropped", () => {
  assertEquals(
    resolves("docs/README.md", "architecture/overview.md"),
    "docs/architecture/overview.md",
  );
  assertEquals(resolves("docs/README.md", "../CLAUDE.md"), "CLAUDE.md");
  assertEquals(resolves("README.md", "./docs/README.md"), "docs/README.md");
  assertEquals(resolves("docs/a.md", "b.md#anchor"), "docs/b.md");
  assertEquals(resolves("docs/a.md", "https://x.dev/a.md"), null);
  assertEquals(resolves("docs/a.md", "mailto:x@y.z"), null);
  assertEquals(resolves("docs/a.md", "#anchor"), null);
});

Deno.test("citedTasks: task names only, flags are not tasks", () => {
  assertEquals(citedTasks("run `deno task build:plugin --watch` or `deno task ci`"), [
    { line: 1, value: "build:plugin" },
    { line: 1, value: "ci" },
  ]);
});

Deno.test("globToRegExp: * stays inside one segment, braces alternate", () => {
  const glob = globToRegExp("core/*.ts");
  assertEquals(glob.test("core/crypto.ts"), true);
  assertEquals(glob.test("core/nested/crypto.ts"), false);
  const braces = globToRegExp("scripts/check-{loc,docs}.ts");
  assertEquals(braces.test("scripts/check-docs.ts"), true);
  assertEquals(braces.test("scripts/check-other.ts"), false);
});

Deno.test("globToRegExp: ** crosses segments, a trailing ** takes the subtree", () => {
  const all = globToRegExp("test/**");
  assertEquals(all.test("test/two-vault-driver.ts"), true);
  assertEquals(all.test("test/scenarios/sync/basic.test.ts"), true);
  assertEquals(all.test("tests/x.ts"), false);
  assertEquals(globToRegExp("**/*.md").test("docs/design/pages/a.md"), true);
  assertEquals(globToRegExp("test/**/*.test.ts").test("test/unit/scripts/a.test.ts"), true);
});

Deno.test("globToRegExp: a mid-pattern **/ matches zero segments too", () => {
  const glob = globToRegExp("test/**/*.ts");
  assertEquals(glob.test("test/a.ts"), true);
  assertEquals(glob.test("test/unit/scripts/a.ts"), true);
  assertEquals(globToRegExp("**/*.md").test("README.md"), true);
  assertEquals(globToRegExp("test/**").test("test/a.ts"), true);
});

Deno.test("coversOf: the frontmatter list, quoted or bare, empty, absent", () => {
  assertEquals(coversOf(doc("[core/*.ts, plugin/sync/merger.ts]", "# x")), [
    "core/*.ts",
    "plugin/sync/merger.ts",
  ]);
  assertEquals(coversOf(doc('["core/*.ts", `server/*.ts`]', "# x")), [
    "core/*.ts",
    "server/*.ts",
  ]);
  assertEquals(coversOf(doc("[]", "# x")), []);
  assertEquals(coversOf(doc("", "# x")), []);
  assertEquals(coversOf("# no frontmatter\n\ncovers: [core/*.ts]"), []);
});

Deno.test("coversOf: a block-style YAML list yields no globs", () => {
  assertEquals(coversOf("---\ncovers:\n  - core/*.ts\n---\n\n# x"), []);
});

Deno.test("watchesOf: the same inline list, absent or empty", () => {
  assertEquals(watchesOf(doc("[]", "", "[test/**/*.ts, test/fuzz/**]")), [
    "test/**/*.ts",
    "test/fuzz/**",
  ]);
  assertEquals(watchesOf(doc("[core/*.ts]", "")), []);
  assertEquals(watchesOf("---\nwatches:\n  - test/x.ts\n---\n\n# x"), []);
});

Deno.test("reachableDocs: path mention, basename mention, chain via another doc", () => {
  const texts = new Map([
    ["docs/a.md", "index links docs/b.md"],
    ["docs/b.md", "see c.md"],
    ["docs/c.md", "see d.md"],
    ["docs/d.md", ""],
    ["docs/e.md", "nothing mentions me"],
  ]);
  assertEquals(
    [...reachableDocs(texts, ["# repo docs/a.md"])].sort(),
    ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
  );
});

Deno.test("reachableDocs: the two README indexes need a path mention", () => {
  const texts = new Map([
    ["docs/README.md", ""],
    ["docs/design/README.md", ""],
  ]);
  assertEquals(reachableDocs(texts, ["see README.md"]).size, 0);
  assertEquals([...reachableDocs(texts, ["[index](docs/README.md)"])], ["docs/README.md"]);
  assertEquals([...reachableDocs(texts, ["[index](design/README.md)"])], ["docs/design/README.md"]);
});

Deno.test("formatViolation: file:line - kind - detail", () => {
  assertEquals(
    formatViolation({ file: "docs/a.md", line: 7, kind: "dead path", detail: "server/gone.ts" }),
    "docs/a.md:7: dead path: server/gone.ts",
  );
});

Deno.test("checkDocs: dead path, broken link, missing task and orphan in one run", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{ "tasks": { "ci": "deno task test" } }`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md");
  await Deno.writeTextFile(
    `${root}/docs/README.md`,
    doc("[]", "[a](missing.md) and `docs/a.md`"),
  );
  await Deno.writeTextFile(
    `${root}/docs/a.md`,
    doc("[]", "`server/gone.ts` and `deno task nope`"),
  );
  await Deno.writeTextFile(`${root}/docs/orphan.md`, doc("[]", ""));
  try {
    assertEquals(await checkDocs(root), [
      { file: "docs/README.md", line: 4, kind: "broken link", detail: "missing.md" },
      { file: "docs/a.md", line: 4, kind: "dead path", detail: "server/gone.ts" },
      { file: "docs/a.md", line: 4, kind: "missing task", detail: "nope" },
      { file: "docs/orphan.md", line: 1, kind: "orphan doc", detail: "not linked from a root doc" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a doc with no covers: frontmatter fails the gate", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(`${root}/docs/bare.md`, "# no frontmatter\n");
  try {
    assertEquals(await checkDocs(root), [
      { file: "docs/bare.md", line: 1, kind: "missing covers", detail: "covers:" },
      { file: "docs/bare.md", line: 1, kind: "orphan doc", detail: "not linked from a root doc" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a covers: glob that matches nothing is a dead covers entry", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/core`);
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md and docs/a.md");
  await Deno.writeTextFile(`${root}/core/crypto.ts`, "");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(`${root}/docs/a.md`, doc("[core/*.ts, core/gone.ts, plugin/*.ts]", ""));
  try {
    assertEquals(await checkDocs(root), [
      { file: "docs/a.md", line: 2, kind: "dead covers", detail: "core/gone.ts" },
      { file: "docs/a.md", line: 2, kind: "dead covers", detail: "plugin/*.ts" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a covers: line that is not an inline list is a bad covers entry", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md and docs/a.md");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(`${root}/docs/a.md`, "---\ncovers:\n  - core/*.ts\n---\n\n# A\n");
  try {
    assertEquals(await checkDocs(root), [
      {
        file: "docs/a.md",
        line: 2,
        kind: "bad covers",
        detail: "covers: must be one inline [ ... ] list",
      },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a watches: entry the gate rejects is reported as watches", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/core`);
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md and docs/a.md");
  await Deno.writeTextFile(`${root}/core/crypto.ts`, "");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(
    `${root}/docs/a.md`,
    "---\ncovers: [core/*.ts]\nwatches:\n  - test/x.ts\n---\n\n# A\n",
  );
  try {
    assertEquals(await checkDocs(root), [
      {
        file: "docs/a.md",
        line: 3,
        kind: "bad watches",
        detail: "watches: must be one inline [ ... ] list",
      },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a watches: glob that matches nothing is a dead watches entry", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/core`);
  await Deno.mkdir(`${root}/docs`);
  await Deno.mkdir(`${root}/test`, { recursive: true });
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md and docs/a.md");
  await Deno.writeTextFile(`${root}/core/crypto.ts`, "");
  await Deno.writeTextFile(`${root}/test/a.test.ts`, "");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(
    `${root}/docs/a.md`,
    doc("[core/*.ts]", "", "[test/*.test.ts, test/gone/**]"),
  );
  try {
    assertEquals(await checkDocs(root), [
      { file: "docs/a.md", line: 3, kind: "dead watches", detail: "test/gone/**" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: a doc linked from a .github template is reachable", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`);
  await Deno.mkdir(`${root}/.github`, { recursive: true });
  await Deno.writeTextFile(`${root}/deno.json`, "{}");
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", ""));
  await Deno.writeTextFile(`${root}/docs/checklist.md`, doc("[]", ""));
  await Deno.writeTextFile(`${root}/.github/pull_request_template.md`, "follow docs/checklist.md");
  try {
    assertEquals(await checkDocs(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkDocs: generated build output is not a dead path", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs`);
  await Deno.writeTextFile(`${root}/deno.json`, `{}`);
  await Deno.writeTextFile(`${root}/CLAUDE.md`, "index: docs/README.md");
  await Deno.writeTextFile(`${root}/docs/README.md`, doc("[]", "`plugin-dist/main.js`"));
  try {
    assertEquals(await checkDocs(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
