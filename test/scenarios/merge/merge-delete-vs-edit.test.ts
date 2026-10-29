import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-delete-vs-edit - A deletes, B edits → B's edit wins",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create base file from A
      A.fakeVault.write("doc.md", "original content");
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // B disconnects
      B.disconnect();

      // A deletes the file
      A.fakeVault.delete("doc.md");
      await A.flushPending();

      // B edits the file (B doesn't know about the deletion)
      const bContent = "B edited the file";
      B.fakeVault.write("doc.md", bContent);
      B.markLocalEdit("doc.md");

      // B reconnects and commits → conflict (delete vs edit) → B's edit wins
      await B.reconnect();
      await B.commitDirect("doc.md");

      // Wait for convergence
      await sleep(1500);

      // B's edit should survive (no conflict file)
      const bFinal = new TextDecoder().decode(await B.fakeVault.readBinary("doc.md"));
      assertEquals(bFinal, bContent, "B's edit should win over A's delete");

      // No conflict file should exist
      const conflictFiles = [...B.fakeVault.files.keys()].filter((p) =>
        p.startsWith("doc (conflict ")
      );
      assertEquals(conflictFiles.length, 0, "no conflict file for delete-vs-edit");
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
