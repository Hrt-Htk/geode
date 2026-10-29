import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// #611 (fuzz seed 201): both devices rewrite the SAME word on the same line.
// The line-level diff3 conflicts, then the per-hunk char-level fallback sees
// two "disjoint" character edits inside that word and splices them: a token
// neither device wrote, and neither edit survives. Keep both instead.
Deno.test({
  name: "merge-same-line-token - both sides rewrite one word on a line → keep both, never splice",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "note.md";
      const base = "head\nRN0-1\nbody\nfooter\n";
      const aContent = "head\nRN0-21\nbody\nfooter\n";
      const bContent = "head\nRN1-17\nbody\nfooter\n";
      const spliced = "RN1-217";

      A.fakeVault.write(path, base);
      await A.flushPending();
      await B.waitForVersion(path);

      B.disconnect();

      A.fakeVault.write(path, aContent);
      await A.flushPending();

      B.fakeVault.write(path, bContent);
      B.markLocalEdit(path);
      await B.reconnect();
      await B.commitDirect(path);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const canonical = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(
        canonical.includes(spliced),
        false,
        "merge spliced the two edits into one token",
      );
      assertEquals(canonical.includes("<<<<<<<"), false, "markers in canonical file");

      const conflicts = [...B.fakeVault.files.keys()].filter((p) =>
        p.startsWith("note (conflict ")
      );
      assertEquals(conflicts.length, 1, "expected one conflict file");
      const conflictContent = new TextDecoder().decode(await B.fakeVault.readBinary(conflicts[0]));

      const kept = [canonical, conflictContent];
      assertEquals(kept.some((t) => t.includes("RN1-17")), true, "local edit lost");
      assertEquals(kept.some((t) => t.includes("RN0-21")), true, "remote edit lost");
    } finally {
      await stop();
    }
  },
});
