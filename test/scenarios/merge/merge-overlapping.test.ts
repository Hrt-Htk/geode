import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-overlapping - A and B edit same line → conflict file created",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create base file from A
      const base = "line 1\nline 2\nline 3";
      A.fakeVault.write("doc.md", base);
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // B disconnects
      B.disconnect();

      // A edits line 2
      const aContent = "line 1\nA edited line 2\nline 3";
      A.fakeVault.write("doc.md", aContent);
      await A.flushPending();

      // B edits the SAME line 2 (overlapping → conflict)
      const bContent = "line 1\nB edited line 2\nline 3";
      B.fakeVault.write("doc.md", bContent);
      B.markLocalEdit("doc.md");

      // B reconnects and commits → conflict → merge → conflict markers → conflict file
      await B.reconnect();
      await B.commitDirect("doc.md");

      // Wait for merge to complete
      await sleep(1500);

      // The canonical file should have server's content (A's edit), no markers
      const bCanonical = new TextDecoder().decode(await B.fakeVault.readBinary("doc.md"));
      assertEquals(bCanonical.includes("<<<<<<"), false, "conflict markers in canonical file");
      assertEquals(bCanonical.includes("======"), false, "conflict markers in canonical file");
      assertEquals(bCanonical.includes(">>>>>>"), false, "conflict markers in canonical file");

      // A conflict file should exist with B's local content
      const conflictFiles = [...B.fakeVault.files.keys()].filter((p) =>
        p.startsWith("doc (conflict ")
      );
      assertEquals(conflictFiles.length, 1, "expected one conflict file");

      const conflictContent = new TextDecoder().decode(
        await B.fakeVault.readBinary(conflictFiles[0]),
      );
      assertEquals(conflictContent, bContent, "conflict file should have B's local content");
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
