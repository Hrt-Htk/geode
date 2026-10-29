import {
  detectMime,
  isMarkdownPath,
  normalizeMarkdownLineEndings,
  normalizePath,
  stripBOM,
} from "../../../core/normalize.ts";
import { assertEquals } from "@std/assert";

Deno.test({
  name: "normalize - normalizePath converts backslashes",
  fn() {
    assertEquals(normalizePath("Notes\\foo.md"), "Notes/foo.md");
  },
});

Deno.test({
  name: "normalize - normalizePath strips leading slashes",
  fn() {
    assertEquals(normalizePath("//notes///foo.md"), "notes/foo.md");
  },
});

Deno.test({
  name: "normalize - normalizePath NFC normalizes NFD input",
  fn() {
    // NFD: e + combining acute = é (two code points)
    const nfd = "caf\u0065\u0301.md";
    // NFC: é (single code point)
    const nfc = "café.md";
    assertEquals(normalizePath(nfd), nfc);
  },
});

Deno.test({
  name: "normalize - normalizePath trims whitespace",
  fn() {
    assertEquals(normalizePath("  notes/test.md  "), "notes/test.md");
  },
});

Deno.test({
  name: "normalize - normalizePath preserves case",
  fn() {
    assertEquals(normalizePath("Notes/Foo.MD"), "Notes/Foo.MD");
  },
});

Deno.test({
  name:
    "normalize - [repro] trim collapses root-level leading/trailing-space paths (documented risk)",
  fn() {
    // Pins today's behavior: normalizePath trims, so a root-level file whose
    // name starts/ends with a space collides with the trimmed path: they hash
    // to the same path and resolve to the same apply target. This is a known
    // risk (issue #365), deliberately NOT changed here because removing trim
    // would rewrite path hashes for existing files. If trim is ever removed,
    // this assertion breaks on purpose.
    assertEquals(normalizePath(" a.md"), "a.md");
    assertEquals(normalizePath("a.md "), "a.md");
    assertEquals(normalizePath(" a.md"), normalizePath("a.md"));
  },
});

Deno.test({
  name: "normalize - normalizeMarkdownLineEndings strips CRLF",
  fn() {
    assertEquals(normalizeMarkdownLineEndings("line1\r\nline2"), "line1\nline2");
  },
});

Deno.test({
  name: "normalize - normalizeMarkdownLineEndings strips bare CR",
  fn() {
    assertEquals(normalizeMarkdownLineEndings("line1\rline2"), "line1\nline2");
  },
});

Deno.test({
  name: "normalize - normalizeMarkdownLineEndings leaves LF alone",
  fn() {
    assertEquals(normalizeMarkdownLineEndings("line1\nline2"), "line1\nline2");
  },
});

Deno.test({
  name: "normalize - stripBOM removes 0xFEFF prefix",
  fn() {
    const withBom = "\uFEFFHello";
    assertEquals(stripBOM(withBom), "Hello");
  },
});

Deno.test({
  name: "normalize - stripBOM leaves non-BOM text alone",
  fn() {
    assertEquals(stripBOM("Hello"), "Hello");
  },
});

Deno.test({
  name: "normalize - isMarkdownPath matches .md",
  fn() {
    assertEquals(isMarkdownPath("notes.md"), true);
    assertEquals(isMarkdownPath("folder/notes.md"), true);
  },
});

Deno.test({
  name: "normalize - isMarkdownPath matches .markdown",
  fn() {
    assertEquals(isMarkdownPath("notes.markdown"), true);
    assertEquals(isMarkdownPath("folder/notes.markdown"), true);
  },
});

Deno.test({
  name: "normalize - isMarkdownPath rejects non-markdown",
  fn() {
    assertEquals(isMarkdownPath("notes.txt"), false);
    assertEquals(isMarkdownPath("notes.md.bak"), false);
    assertEquals(isMarkdownPath("notes"), false);
    assertEquals(isMarkdownPath("README"), false);
  },
});

Deno.test({
  name: "normalize - detectMime returns correct types",
  fn() {
    assertEquals(detectMime("notes.md"), "text/markdown");
    assertEquals(detectMime("notes.markdown"), "text/markdown");
    assertEquals(detectMime("notes.txt"), "text/plain");
    assertEquals(detectMime("data.json"), "application/json");
    assertEquals(detectMime("canvas.canvas"), "application/json");
    assertEquals(detectMime("img.png"), "image/png");
    assertEquals(detectMime("photo.jpg"), "image/jpeg");
    assertEquals(detectMime("photo.jpeg"), "image/jpeg");
    assertEquals(detectMime("doc.pdf"), "application/pdf");
    assertEquals(detectMime("file.xyz"), "application/octet-stream");
  },
});
