import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "reconnect-replay - B disconnects, A commits 3 times, B reconnects and receives all",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Establish baseline: both see the same initial file
      A.fakeVault.write("shared.md", "initial");
      await A.flushPending();
      await B.waitForVersion("shared.md");

      // B disconnects
      B.disconnect();

      // A makes 3 commits while B is offline
      const contents = ["edit 1", "edit 2", "edit 3"];
      for (const content of contents) {
        A.fakeVault.write("shared.md", content);
        await A.flushPending();
      }

      // B reconnects: should replay missing versions
      await B.reconnect();

      // B should converge to A's latest content
      await B.waitForVersion("shared.md", 4); // version 1 (initial) + 3 edits
      const bContent = new TextDecoder().decode(await B.fakeVault.readBinary("shared.md"));
      assertEquals(bContent, contents[contents.length - 1]);
    } finally {
      await stop();
    }
  },
});
