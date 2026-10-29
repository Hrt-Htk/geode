import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Regression test for issue #199: resync-from-scratch with files on disk.
 *
 * After clearing local state, getAbstractFileByPath returns null (empty registry),
 * so writeVaultBinary would fall through to createBinary. Real Obsidian's createBinary
 * throws when the file already exists on disk.
 *
 * The fix adds an adapter.exists guard before createBinary: if the file exists on disk,
 * use adapter.writeBinary (which overwrites) instead of createBinary.
 */
Deno.test({
  name: "resync-from-scratch - File already exists when registry is empty but files on disk",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // 1. Create files on A, sync to B
      A.fakeVault.write("notes/a.md", "hello from A");
      A.fakeVault.writeBinary("media/c.bin", new Uint8Array([1, 2, 3]));
      await A.flushPending();

      await B.waitForVersion("notes/a.md", 1);
      await B.waitForVersion("media/c.bin", 1);
      assertEquals(B.fakeVault.files.size, 2);

      // 2. Clear B's local state (simulates fresh restart): files remain on disk
      await B.resetLocalState();

      // 3. Patch B's vault to behave like real Obsidian
      B.fakeVault.getAbstractFileByPath = () => null; // registry empty after state clear
      B.fakeVault.createBinary = () => {
        throw new Error("File already exists");
      };
      B.fakeVault.modifyBinary = (
        _file: unknown,
        _data: ArrayBuffer,
        _opts?: { mtime?: number },
      ) => {
        // modifyBinary would write data: not reached in the bug scenario
        // because getAbstractFileByPath returns null
        return;
      };

      // 4. resyncFromScratch should succeed: the fix routes through adapter.exists
      // + adapter.writeBinary, bypassing createBinary entirely.
      await B.resyncFromScratch();

      // Both files should exist after resync
      assert(B.fakeVault.fileExists("notes/a.md"), "notes/a.md should exist after resync");
      assert(B.fakeVault.fileExists("media/c.bin"), "media/c.bin should exist after resync");
    } finally {
      await stop();
    }
  },
});
