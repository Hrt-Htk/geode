import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "resync-from-scratch - rebuild restores disk and local state without duplicates",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const binaryBytes = new Uint8Array([1, 3, 5, 7, 9]);

      A.fakeVault.write("notes/a.md", "alpha");
      A.fakeVault.write("notes/b.md", "beta");
      A.fakeVault.writeBinary("media/c.bin", binaryBytes);
      await A.flushPending();

      await B.waitForVersion("notes/a.md", 1);
      await B.waitForVersion("notes/b.md", 1);
      await B.waitForVersion("media/c.bin", 1);

      B.fakeVault.files.clear();
      B.fakeVault.mtimes.clear();
      await B.resetLocalState();

      const result = await B.resyncFromScratch();

      assertEquals(result.appliedFiles, 3);
      assertEquals(B.fakeVault.files.size, A.fakeVault.files.size);

      for (const [path, bytes] of A.fakeVault.files) {
        assertEquals(
          [...B.fakeVault.files.get(path)!],
          [...bytes],
          `resynced bytes mismatch for ${path}`,
        );
        assertEquals(
          B.state.getLocalFile(path) !== null,
          true,
          `missing rebuilt local state for ${path}`,
        );
      }
    } finally {
      await stop();
    }
  },
});
