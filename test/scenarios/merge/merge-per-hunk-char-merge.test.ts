import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// #385: mergeText's char-level diff3 fallback ran over the WHOLE document and
// was capped at 1024 chars of document length, so any note over ~1 KB with a
// same-line concurrent edit became a conflict file. Now the char-level merge
// runs per conflicting hunk, so cost is bounded by hunk size, not doc size.

// Conflict files strip the extension: "doc.md" → "doc.conflict-<stamp>.md".
function conflictPath(vault: { files: Map<string, Uint8Array> }, path: string): string | null {
  const stem = path.replace(/\.[^/.]+$/, "");
  return [...vault.files.keys()].find((p) => p.startsWith(`${stem} (conflict `)) ?? null;
}

// Same-line, disjoint-character concurrent edit: A prepends, B appends.
// With the old whole-doc cap this fell to a conflict file; it must merge clean.
Deno.test({
  name:
    "merge-per-hunk-char-merge - ~5 KB note same-line disjoint edit merges cleanly, char-diff stays per-hunk",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = "big.md";
    const base = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const aLines = base.split("\n");
    const bLines = base.split("\n");
    aLines[60] = "A: " + aLines[60];
    bLines[60] = bLines[60] + " B!";

    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();
      A.fakeVault.write(path, aLines.join("\n"));
      await A.flushPending();

      B.fakeVault.write(path, bLines.join("\n"));
      B.markLocalEdit(path);
      await B.reconnect();

      const t0 = Date.now();
      await B.commitDirect(path);
      const elapsed = Date.now() - t0;

      assertEquals(conflictPath(B.fakeVault, path), null, "no conflict file");
      const merged = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(merged.includes("A: line 60"), true, "A's edit missing");
      assertEquals(
        merged.includes("line 60 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx B!"),
        true,
        "B's edit missing",
      );
      assert(
        elapsed < 10_000,
        `merge must stay per-hunk; whole-doc char diff3 on this size takes seconds: took ${elapsed} ms`,
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "merge-per-hunk-char-merge - ~20 KB note same-line disjoint edit merges cleanly, char-diff stays per-hunk",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = "big.md";
    const base = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const aLines = base.split("\n");
    const bLines = base.split("\n");
    aLines[250] = "A: " + aLines[250];
    bLines[250] = bLines[250] + " B!";

    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();
      A.fakeVault.write(path, aLines.join("\n"));
      await A.flushPending();

      B.fakeVault.write(path, bLines.join("\n"));
      B.markLocalEdit(path);
      await B.reconnect();

      const t0 = Date.now();
      await B.commitDirect(path);
      const elapsed = Date.now() - t0;

      assertEquals(conflictPath(B.fakeVault, path), null, "no conflict file");
      const merged = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(merged.includes("A: line 250"), true, "A's edit missing");
      assertEquals(
        merged.includes("line 250 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx B!"),
        true,
        "B's edit missing",
      );
      assert(
        elapsed < 10_000,
        `merge must stay per-hunk; whole-doc char diff3 on this size takes seconds: took ${elapsed} ms`,
      );
    } finally {
      await stop();
    }
  },
});

// Two conflicting hunks: one char-merges, the other truly conflicts → the whole
// result is a conflict_file with no markers anywhere (never a partial commit).
Deno.test({
  name:
    "merge-per-hunk-char-merge - one char-mergeable + one true conflict → conflict_file, no markers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = "doc.md";
    const base = Array.from({ length: 30 }, (_, i) => `line ${i} content`).join("\n");
    const aLines = base.split("\n");
    const bLines = base.split("\n");
    // Line 10: disjoint → char-merges. Line 20: both fully replace → true conflict.
    aLines[10] = "A10: " + aLines[10];
    bLines[10] = bLines[10] + " b10!";
    aLines[20] = "A-replace";
    bLines[20] = "B-replace";

    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();
      A.fakeVault.write(path, aLines.join("\n"));
      await A.flushPending();

      B.fakeVault.write(path, bLines.join("\n"));
      B.markLocalEdit(path);
      await B.reconnect();
      await B.commitDirect(path);
      await new Promise((r) => setTimeout(r, 500));

      const primary = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(primary.includes("<<<<<<"), false, "no markers in primary");
      assertEquals(primary.includes(">>>>>>"), false, "no markers in primary");
      assertEquals(conflictPath(B.fakeVault, path) !== null, true, "conflict file surfaced");
    } finally {
      await stop();
    }
  },
});

// Edit on the last line, base has NO trailing newline: merge must stay clean
// and must not gain/lose a trailing newline.
Deno.test({
  name: "merge-per-hunk-char-merge - last line without trailing newline merges cleanly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = "doc.md";
    const base = "line 1 content\nline 2 content\nline 3 content";
    const aContent = "line 1 content\nline 2 content\nline 3 content A!";

    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();
      A.fakeVault.write(path, aContent);
      await A.flushPending();

      // B edits the same last line with a disjoint char range (prepend).
      const bLines = base.split("\n");
      bLines[2] = " B! " + bLines[2];
      B.fakeVault.write(path, bLines.join("\n"));
      B.markLocalEdit(path);
      await B.reconnect();
      await B.commitDirect(path);
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(conflictPath(B.fakeVault, path), null, "no conflict file");
      const merged = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(merged.includes("A!"), true, "A's edit missing");
      assertEquals(merged.includes(" B! "), true, "B's edit missing");
      assertEquals(merged.endsWith("A!"), true, "trailing newline changed");
    } finally {
      await stop();
    }
  },
});

// A conflicting hunk at the START of the file must merge cleanly (boundary case).
Deno.test({
  name: "merge-per-hunk-char-merge - hunk at start of file merges cleanly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const path = "doc.md";
    const base = "line 1 content\nline 2 content\nline 3 content";
    const aLines = base.split("\n");
    const bLines = base.split("\n");
    aLines[0] = "A: " + aLines[0];
    bLines[0] = bLines[0] + " B!";

    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();
      A.fakeVault.write(path, aLines.join("\n"));
      await A.flushPending();

      B.fakeVault.write(path, bLines.join("\n"));
      B.markLocalEdit(path);
      await B.reconnect();
      await B.commitDirect(path);
      await new Promise((r) => setTimeout(r, 500));

      assertEquals(conflictPath(B.fakeVault, path), null, "no conflict file");
      const merged = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(merged.startsWith("A: line 1 content B!"), true, "hunk-at-start merge wrong");
    } finally {
      await stop();
    }
  },
});
