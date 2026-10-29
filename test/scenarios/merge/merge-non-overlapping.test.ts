import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-non-overlapping - A and B edit different lines → clean merge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create base file from A
      const base = "line 1\nline 2\nline 3\nline 4\nline 5";
      A.fakeVault.write("doc.md", base);
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // B disconnects
      B.disconnect();

      // A edits line 1
      const aContent = "A edited line 1\nline 2\nline 3\nline 4\nline 5";
      A.fakeVault.write("doc.md", aContent);
      await A.flushPending();

      // B edits line 5 (different from A)
      const bContent = "line 1\nline 2\nline 3\nline 4\nB edited line 5";
      B.fakeVault.write("doc.md", bContent);
      B.markLocalEdit("doc.md");

      // B reconnects → replays A's version → hasLocalEdits=true → conflict → merge
      await B.reconnect();

      // B commits → conflict → merge
      await B.commitDirect("doc.md");

      // Wait for merge to complete
      await sleep(1500);

      // Both sides should have both edits
      const bFinal = new TextDecoder().decode(await B.fakeVault.readBinary("doc.md"));
      assertEquals(bFinal.includes("A edited line 1"), true, "A's edit missing from B");
      assertEquals(bFinal.includes("B edited line 5"), true, "B's edit missing from B");

      // A should receive B's merged version back
      await A.waitForConvergence(B, "doc.md");
      const aFinal = new TextDecoder().decode(await A.fakeVault.readBinary("doc.md"));
      assertEquals(aFinal.includes("A edited line 1"), true, "A's edit missing from A");
      assertEquals(aFinal.includes("B edited line 5"), true, "B's edit missing from A");
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
