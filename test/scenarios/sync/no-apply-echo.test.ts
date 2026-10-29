import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Regression test for issue #187: apply echo.
 *
 * When a remote version is applied, applyContent writes the file to disk via
 * writeBinary. That write fires a modify event which VaultEventHandler
 * captures and enqueues as a commit: an echo re-push of the content B just
 * downloaded.
 *
 * After fix: the event handler should not enqueue a commit for files that
 * were just written by the apply path.
 */

Deno.test({
  name: "no-apply-echo - applying a remote version does not enqueue a self-commit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // A writes and commits a file
      const path = "note.md";
      const content = "Hello from A";
      A.fakeVault.write(path, content);
      await A.flushPending();

      // B receives and applies A's version
      await B.waitForVersion(path, 1);

      // Assert immediately (before any debounce flush): B's applied write
      // did NOT enqueue a self-commit.
      const pendingOps = B.eventHandler.getPendingOps();
      const echoOps = pendingOps.filter((op) => op.path === path);

      assertEquals(
        echoOps.length,
        0,
        `Applying a remote version should not enqueue a self-commit, but got ${echoOps.length} pending op(s) for ${path}: ${
          echoOps.map((op) => JSON.stringify(op)).join(", ")
        }`,
      );

      // Positive control: a real local edit IS enqueued
      B.fakeVault.write(path, "Local edit on B");
      await new Promise((r) => setTimeout(r, 0));
      const afterEdit = B.eventHandler.getPendingOps();
      const realEditOps = afterEdit.filter((op) => op.path === path);
      assertEquals(
        realEditOps.length,
        1,
        `A real local edit should be enqueued, but got ${realEditOps.length} pending op(s) for ${path}`,
      );
    } finally {
      await stop();
    }
  },
});
