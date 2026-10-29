import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

/**
 * Regression test for issue #217: deleting a conflict file must clear the
 * tracked conflict count. Previously `conflictCount` was a bare number that
 * was only ever incremented, so the status bar showed "N conflicts" forever.
 */
Deno.test({
  name: "conflict-clear-on-delete: deleting a conflict file decrements the conflict count",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "attachment.pdf";
      const base = new Uint8Array([1, 2, 3, 4]);
      const serverWinner = new Uint8Array([5, 6, 7, 8]);
      const localLoser = new Uint8Array([9, 10, 11, 12]);

      // 1. A writes base version, B syncs it
      A.fakeVault.writeBinary(path, base);
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // 2. B disconnects
      B.disconnect();

      // 3. A writes a newer version (server winner)
      A.fakeVault.writeBinary(path, serverWinner);
      await A.flushPending();

      // 4. On B, make an UNTRACKED divergent edit on disk.
      B.fakeVault.files.set(path, new Uint8Array(localLoser));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);

      // 5. B reconnects: server replays A's version, conflict is surfaced
      await B.reconnect();

      // 6. Wait for the conflict file to appear
      await waitForConflictFile(B, "attachment", ".pdf");

      // 7. Assert conflict count is >= 1
      assertEquals(
        B.syncManager.getConflictCount() >= 1,
        true,
        "conflict count should be >= 1 after conflict is surfaced",
      );

      // 8. Discover the conflict file path
      const conflictPath = [...B.fakeVault.files.keys()].find((filePath) =>
        isConflictPath(filePath)
      );
      assertEquals(Boolean(conflictPath), true, "conflict file path should be found");

      // 9. Simulate user deleting the conflict file: remove from vault AND
      //    feed the deletion through handlePendingOps (the real path a vault
      //    delete takes).
      await B.fakeVault.delete(conflictPath!);
      await B.syncManager.handlePendingOps([{ path: conflictPath!, kind: "delete" }]);

      // 10. Assert conflict count is now 0
      assertEquals(
        B.syncManager.getConflictCount(),
        0,
        "conflict count should be 0 after the conflict file is deleted",
      );
    } finally {
      await stop();
    }
  },
});

async function waitForConflictFile(
  plugin: Awaited<ReturnType<typeof pair>>["A"],
  prefix: string,
  ext: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = [...plugin.fakeVault.files.keys()].some((filePath) =>
      filePath.startsWith(`${prefix} (conflict `) && filePath.endsWith(ext)
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for conflict file with prefix "${prefix}"`);
}
