import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Regression test for issue #13: binary divergence on reconnect must produce
 * a conflict file, not silently overwrite one side.
 *
 * Scenario: A and B both have a binary file. B disconnects. A writes a new
 * version. B makes an untracked divergent edit on disk (no commit, no cursor
 * advance). When B reconnects, the server replays A's version. The apply guard
 * detects the disk divergence. For binaries, this MUST surface a conflict
 * immediately (server version to main path, local bytes to .conflict- file).
 */
Deno.test({
  name: "binary-divergence-conflict: untracked binary edit on reconnect produces conflict file",
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
      //    Do NOT commit, do NOT markLocalEdit, do NOT advance B's sync cursor.
      //    The server will replay A's newer version on reconnect, hitting the
      //    apply guard which detects disk divergence.
      B.fakeVault.files.set(path, new Uint8Array(localLoser));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);

      // 5. B reconnects: server replays A's version
      await B.reconnect();

      // 6. Wait for the conflict file to appear
      await waitForConflictFile(B, "attachment", ".pdf");

      // 7. Assertions
      // Main file should be the server winner
      assertEquals(
        [...await B.fakeVault.readBinary(path)],
        [...serverWinner],
        "canonical binary should be the server winner",
      );

      // A conflict file should exist with the local loser's bytes
      const conflictPath = [...B.fakeVault.files.keys()].find((filePath) =>
        filePath.startsWith("attachment (conflict ") && filePath.endsWith(".pdf")
      );
      assertEquals(Boolean(conflictPath), true, "conflict file should exist");
      assertEquals(
        [...await B.fakeVault.readBinary(conflictPath!)],
        [...localLoser],
        "conflict file should preserve the local divergent bytes",
      );

      // SyncManager should have recorded a conflict
      assertEquals(B.syncManager.getConflictCount() >= 1, true, "conflict count should be >= 1");
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
