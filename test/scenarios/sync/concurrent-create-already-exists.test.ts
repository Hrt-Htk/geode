import { assert, assertEquals } from "@std/assert";
import { FakeVault, pair } from "../../two-vault-driver.ts";
import { getRecentLog, setDebugLogging } from "../../../plugin/plumbing/log.ts";

setDebugLogging(true);

/**
 * Regression test for issue #196: concurrent create on the same path.
 *
 * Both vaults create the same file independently (no sync between them).
 * When B receives A's version, writeVaultBinary checks getAbstractFileByPath.
 * If the file exists on disk but isn't tracked, it falls through to createBinary.
 * In real Obsidian, createBinary throws "File already exists".
 * FakeVault's adapter.writeBinary silently overwrites, so we patch createBinary
 * to throw, mimicking real Obsidian behavior.
 */
Deno.test({
  name: "concurrent-create-already-exists: both vaults create same file independently",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "shared/file.txt";

      // Patch createBinary to throw "File already exists" when path exists,
      // mimics real Obsidian. FakeVault's adapter.writeBinary silently overwrites.
      const strictCreateBinary = (vault: typeof A) =>
      async (
        p: string,
        data: ArrayBuffer,
        opts?: { mtime?: number },
      ) => {
        if (vault.fakeVault.fileExists(p)) throw new Error("File already exists.");
        await vault.fakeVault.adapter.writeBinary(p, new Uint8Array(data), opts);
      };
      (A.syncManager as unknown as { deps: { vault: FakeVault } }).deps.vault.createBinary =
        strictCreateBinary(A);
      (B.syncManager as unknown as { deps: { vault: FakeVault } }).deps.vault.createBinary =
        strictCreateBinary(B);

      // Both vaults create the same file independently (no sync between them)
      A.fakeVault.write(path, "created by A");
      B.fakeVault.write(path, "created by B");

      // Flush A → A commits to server
      await A.flushPending();
      // Flush B → B commits to server (same path, different content)
      await B.flushPending();

      // Wait for cross-sync to settle: both vaults must converge on one content.
      await A.waitForConvergence(B, path);

      // Check log for "File already exists" errors
      // The error is logged as fields.error, not in msg.
      const errors = getRecentLog().filter(
        (e) => e.level === "error" && String(e.fields.error ?? "").includes("File already exists"),
      );

      // Assert both files still exist on disk (session didn't crash)
      assert(A.fakeVault.fileExists(path), "A should have the file");
      assert(B.fakeVault.fileExists(path), "B should have the file");

      // With the fix, writeVaultBinary routes through adapter.exists + adapter.writeBinary
      // when getAbstractFileByPath returns null but the file exists on disk.
      // No "File already exists" error should be logged.
      assertEquals(
        errors.length,
        0,
        `expected no 'File already exists' errors after fix, got ${errors.length}`,
      );
    } finally {
      await stop();
    }
  },
});
