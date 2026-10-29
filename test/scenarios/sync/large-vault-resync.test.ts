import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Test: large-vault cold join / resync applies ALL heads (no drops).
 *
 * Seeds a vault with many files, wipes device B, resyncs, and asserts
 * every file converges with identical bytes.
 */
Deno.test({
  name: "large-vault-resync - applies all heads without drops",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const FILE_COUNT = 200;
      const contentPerFile = "x".repeat(256); // ~256 bytes → multiple chunks per file

      // A creates many files
      for (let i = 0; i < FILE_COUNT; i++) {
        const path = `file/${i.toString().padStart(4, "0")}.md`;
        A.fakeVault.write(path, contentPerFile);
      }
      await A.flushPending();

      // Wait for B to receive all files live
      for (let i = 0; i < FILE_COUNT; i++) {
        const path = `file/${i.toString().padStart(4, "0")}.md`;
        await B.waitForVersion(path);
      }

      // Wipe B's vault and local state
      B.fakeVault.files.clear();
      B.fakeVault.mtimes.clear();
      await B.resetLocalState();

      // Resync from scratch
      await B.resyncFromScratch();

      // Assert: all files landed
      assertEquals(
        B.fakeVault.files.size,
        FILE_COUNT,
        `expected ${FILE_COUNT} files on disk, got ${B.fakeVault.files.size}`,
      );

      // Assert: converged bytes
      for (let i = 0; i < FILE_COUNT; i++) {
        const path = `file/${i.toString().padStart(4, "0")}.md`;
        const expected = new TextEncoder().encode(contentPerFile);
        const actual = await B.fakeVault.readBinary(path);
        assertEquals(
          [...actual],
          [...expected],
          `converged bytes mismatch for ${path}`,
        );
      }

      // Assert: local state entries
      assertEquals(
        B.state.getAllLocalFiles().size,
        FILE_COUNT,
        `expected ${FILE_COUNT} local state entries`,
      );

      // Assert: cursor advanced
      assertEquals(B.state.getSyncCursor() > 0, true, "sync cursor should have advanced");
    } finally {
      await stop();
    }
  },
});
