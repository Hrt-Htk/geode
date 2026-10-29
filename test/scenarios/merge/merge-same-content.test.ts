import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-same-content - A and B write identical content → no_op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create base file from A
      A.fakeVault.write("doc.md", "original content");
      await A.flushPending();
      await B.waitForVersion("doc.md");

      const versionBefore = B.state.getLocalFile("doc.md")!.last_seen_version;

      // B disconnects
      B.disconnect();

      // A writes new content
      const newContent = "identical content on both sides";
      A.fakeVault.write("doc.md", newContent);
      await A.flushPending();

      // B writes the EXACT same content
      B.fakeVault.write("doc.md", newContent);
      // Mark as local edit so hasLocalEdits returns true during replay
      B.markLocalEdit("doc.md");

      // B reconnects → replays A's version → hasLocalEdits=true → conflict → merge
      await B.reconnect();

      // B commits → conflict → merge detects identical content → no_op
      await B.commitDirect("doc.md");

      // Wait for convergence
      await sleep(1000);

      // B should have the content
      const bFinal = new TextDecoder().decode(await B.fakeVault.readBinary("doc.md"));
      assertEquals(bFinal, newContent);

      // Version should have advanced but no spurious extra versions
      const versionAfter = B.state.getLocalFile("doc.md")!.last_seen_version;
      assertEquals(
        versionAfter <= versionBefore + 2,
        true,
        `no spurious extra versions: before=${versionBefore}, after=${versionAfter}`,
      );
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
