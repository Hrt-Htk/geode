import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// #385: the char-level diff3 fallback previously ran over the whole document
// and was capped by document length. It now runs per conflicting hunk, capped
// by HUNK size. A same-line edit in a big doc must merge cleanly (covered in
// merge-per-hunk-char-merge.test.ts); this test pins the other half: a single
// hunk whose three sides exceed the hunk cap still goes straight to a conflict
// file, fast, with no markers (never a marker commit).
Deno.test({
  name: "merge-per-hunk-char-merge - over-cap single hunk yields conflict_file quickly, no markers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "big.md";
      // A single ~3 KB line: any same-line edit is one hunk well over the cap.
      const base = "z".repeat(3000);
      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();

      A.fakeVault.write(path, "A:" + base);
      await A.flushPending();

      B.fakeVault.write(path, base + ":B");
      B.markLocalEdit(path);
      await B.reconnect();

      const t0 = Date.now();
      await B.commitDirect(path);
      const elapsed = Date.now() - t0;

      const conflictPath = [...B.fakeVault.files.keys()].find((p) =>
        p.startsWith("big (conflict ")
      ) ?? null;
      assertEquals(Boolean(conflictPath), true, "conflict file surfaced");
      assert(
        elapsed < 10_000,
        `over-cap hunk must skip char fallback; whole-doc char diff3 on 3 KB takes seconds: took ${elapsed} ms`,
      );

      // Never a marker commit: primary must not contain markers.
      const primary = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(primary.includes("<<<<<<"), false, "no markers in primary file");
      assertEquals(primary.includes(">>>>>>"), false, "no markers in primary file");
    } finally {
      await stop();
    }
  },
});
