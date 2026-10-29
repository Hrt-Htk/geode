import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "origin-echo - replayed self-version advances cursor without rewriting disk",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("echo.md", "origin content");
      await A.flushPending();
      await B.waitForVersion("echo.md", 1);

      const mtimeBefore = A.fakeVault.mtimes.get("echo.md");
      // The real session wires the cursor sink: a commit ack records the acked
      // seq in the state cursor (the old driver had no sink and stayed at 0).
      assertEquals(
        A.state.getSyncCursor(),
        1,
        "commit ack advances the origin cursor via the cursor sink",
      );

      A.disconnect();
      await A.reconnect();
      await A.waitForSyncCursor(1);

      assertEquals(A.state.getSyncCursor(), 1, "self echo should advance sync cursor");
      assertEquals(
        A.fakeVault.mtimes.get("echo.md"),
        mtimeBefore,
        "self echo should not rewrite the file on disk",
      );

      const content = new TextDecoder().decode(await A.fakeVault.readBinary("echo.md"));
      assertEquals(content, "origin content");
    } finally {
      await stop();
    }
  },
});
