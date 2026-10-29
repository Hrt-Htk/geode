// Unit tests for the dash gate (#668): no U+2014 or U+2013 in a tracked file.
// Both characters are written as escapes so this file passes its own gate.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ALLOWED, checkDashes, formatViolation, scan } from "../../../scripts/check-dashes.ts";

const EM = "\u2014";
const EN = "\u2013";
const file = (path: string, text: string) => [{ path, text }];

Deno.test("scan: a file with neither character has no hits", () => {
  assertEquals(scan(file("a.md", "a hyphen - a middle dot · a minus sign - 1-2\n")), []);
});

Deno.test("scan: an em dash is reported at the line it sits on", () => {
  assertEquals(scan(file("a.ts", `// clean\nconst x = "a ${EM} b";\n`)), [
    { file: "a.ts", line: 2, kind: "em dash" },
  ]);
});

Deno.test("scan: an en dash is reported, and every hit on one line is kept", () => {
  assertEquals(scan(file("a.md", `1${EN}2 ${EM} ${EN}\n`)), [
    { file: "a.md", line: 1, kind: "en dash" },
    { file: "a.md", line: 1, kind: "em dash" },
    { file: "a.md", line: 1, kind: "en dash" },
  ]);
});

Deno.test("scan: the allowlisted tree passes, the same dash outside it does not", () => {
  const vendored = [...ALLOWED][0];
  assertEquals(scan(file(`${vendored}reference/eslint-setup.md`, `a ${EM} b`)), []);
  assertEquals(scan(file("docs/architecture/plugin.md", `a ${EM} b`)), [
    { file: "docs/architecture/plugin.md", line: 1, kind: "em dash" },
  ]);
});

Deno.test("formatViolation: file:line: kind", () => {
  assertEquals(
    formatViolation({ file: "a.md", line: 7, kind: "em dash" }),
    "a.md:7: em dash",
  );
});

Deno.test("checkDashes: tracks text files only, skipping binaries and lock files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "dash-gate-" });
  try {
    const git = (args: string[]) =>
      new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" }).output();
    await git(["init"]);
    await Deno.writeTextFile(join(dir, "notes.md"), `a ${EM} b\n`);
    await Deno.writeTextFile(join(dir, "package-lock.json"), `a ${EM} b\n`);
    await Deno.writeFile(join(dir, "blob.bin"), new Uint8Array([0x61, 0x00, 0xe2, 0x80, 0x94]));
    await git(["add", "-A"]);
    assertEquals((await checkDashes(dir)).map((v) => v.file), ["notes.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
