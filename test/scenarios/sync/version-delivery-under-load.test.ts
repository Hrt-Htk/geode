import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Issue #193: statusbar-dirty-marker hybrid phone-as-A direction times out
 * waiting for FILE_B to appear on device A after B commits it.
 *
 * This test exercises the version delivery mechanism under load: B creates
 * many files and flushes them, then A must receive all versions within a
 * reasonable timeout.  If the WebSocket hub drops or delays messages under
 * load, this test will fail.
 */
Deno.test({
  name: "version-delivery-under-load - B creates 20 files, A receives all",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { B, stop } = await pair();
    try {
      const fileCount = 20;
      const files: [string, string][] = [];

      // B creates many files
      for (let i = 0; i < fileCount; i++) {
        const path = `load/file-${i}.md`;
        const content = `content for file ${i}`;
        B.fakeVault.write(path, content);
        files.push([path, content]);
      }

      // Flush all at once: this triggers the event handler to commit all 20
      await B.flushPending();

      // A must receive all files within a reasonable timeout
      const timeoutMs = 30_000;
      for (const [path, expectedContent] of files) {
        await B.waitForVersion(path, undefined, timeoutMs);
        const content = new TextDecoder().decode(await B.fakeVault.readBinary(path));
        assertEquals(content, expectedContent, `B's ${path} content mismatch`);
      }
    } finally {
      await stop();
    }
  },
});

/**
 * Same as above but with a larger batch and concurrent writes from both sides,
 * to stress the version queue serialization.
 */
Deno.test({
  name: "version-delivery-under-load - bidirectional burst of 15 files each",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const fileCount = 15;

      // Both sides write files simultaneously
      const aFiles: [string, string][] = [];
      const bFiles: [string, string][] = [];

      for (let i = 0; i < fileCount; i++) {
        A.fakeVault.write(`a/burst-${i}.md`, `from-a-${i}`);
        B.fakeVault.write(`b/burst-${i}.md`, `from-b-${i}`);
        aFiles.push([`a/burst-${i}.md`, `from-a-${i}`]);
        bFiles.push([`b/burst-${i}.md`, `from-b-${i}`]);
      }

      // Flush both
      await Promise.all([A.flushPending(), B.flushPending()]);

      // A must have all B files
      const timeoutMs = 30_000;
      for (const [path, expected] of bFiles) {
        await A.waitForVersion(path, undefined, timeoutMs);
        const content = new TextDecoder().decode(await A.fakeVault.readBinary(path));
        assertEquals(content, expected, `A's ${path} content mismatch`);
      }

      // B must have all A files
      for (const [path, expected] of aFiles) {
        await B.waitForVersion(path, undefined, timeoutMs);
        const content = new TextDecoder().decode(await B.fakeVault.readBinary(path));
        assertEquals(content, expected, `B's ${path} content mismatch`);
      }
    } finally {
      await stop();
    }
  },
});

/**
 * Simulates the gate9 scenario: A has a dirty file (debounced, not yet committed),
 * while B commits a different file. A must receive B's file without losing its
 * own dirty state.
 */
Deno.test({
  name: "version-delivery-under-load - remote file arrives while A has debounced local edit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Establish baseline: both see an initial file
      A.fakeVault.write("shared.md", "initial");
      await A.flushPending();
      await B.waitForVersion("shared.md");

      // A makes a local edit: do NOT flush (let debounce hold it)
      A.fakeVault.write("shared.md", "edited by A");

      // Verify A has the edit queued
      const pendingOps = A.eventHandler.getPendingOps();
      assert(
        pendingOps.some((op) => op.path === "shared.md"),
        "A should have shared.md in pending ops",
      );

      // B creates and commits a different file
      B.fakeVault.write("from-b.md", "from B");
      await B.flushPending();

      // A must receive B's file
      await A.waitForVersion("from-b.md", undefined, 15_000);
      const content = new TextDecoder().decode(await A.fakeVault.readBinary("from-b.md"));
      assertEquals(content, "from B");

      // A's own edit should still be in pending (not clobbered by the remote sync)
      const pendingAfter = A.eventHandler.getPendingOps();
      assert(
        pendingAfter.some((op) => op.path === "shared.md"),
        "A's debounced edit must not be clobbered by remote sync",
      );

      // Now flush A's edit and verify convergence
      await A.flushPending();
      await B.waitForVersion("shared.md", 2, 15_000);
      const bContent = new TextDecoder().decode(await B.fakeVault.readBinary("shared.md"));
      assertEquals(bContent, "edited by A");
    } finally {
      await stop();
    }
  },
});
