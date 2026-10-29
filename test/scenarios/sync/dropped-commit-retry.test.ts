import { assert, assertEquals, assertFalse } from "@std/assert";
import { pair, waitFor } from "../../two-vault-driver.ts";
import { shouldStampBackup } from "../../../plugin/sync/backup-stamp.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";
import type { CommitRequest, CommitResult } from "../../../plugin/sync/commit-channel.ts";

// #339: a commit that fails past the retry cap must be tracked as dropped,
// block the last-backup stamp, stay away from the other device, and be
// re-committed by retryDropped() once the fault clears.
//
// Fault seam: the real commit path (chunking, encryption, blob upload) runs
// against the live server; only the transport's commit boundary is forced to
// resolve an error: the same result a "commit timeout" / "socket closed"
// produces in production. No production test hooks.
function lastBackupAt(state: StateDB): number {
  return (JSON.parse(state.serializeSyncCursor()) as { last_backup_at: number }).last_backup_at;
}

Deno.test({
  name: "dropped-commit-retry - dropped op is tracked, blocks the stamp, and retries clean",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    try {
      const path = "notes/dropped.md";
      const stampBefore = lastBackupAt(p.A.state);

      // Fault: every commit from A resolves an error (retry cap is 5 → 6th fails → dropped).
      // Count attempts on the failing transport: a reconnect that lands while the
      // previous live drain is still running joins that pass (requeuedThisPass) and
      // adds no attempt, so a fixed reconnect count is not a fixed attempt count.
      let attempts = 0;
      const realCommit = p.A.transport.commit.bind(p.A.transport);
      const failingCommit = (_req: CommitRequest): Promise<CommitResult> => {
        attempts++;
        return Promise.resolve({ kind: "error", message: "fault: commit rejected" });
      };
      p.A.transport.commit = failingCommit;

      // First attempt fails → op is requeued. In production the retry happens on
      // the next reconnect (the "live" drain); drive the same drain directly via
      // the commit queue until the retry cap (5) is exceeded and the op is dropped.
      // (A full reconnect would also rescan the reconciler, which re-enqueues the
      // op as a fresh intent and resets the budget: the drain isolates the retry
      // logic this test is about.) Bounded so a real regression (op never dropped)
      // still fails below.
      p.A.fakeVault.write(path, "dropped content\n");
      await p.A.commitDirect(path);
      const deadline = Date.now() + 60_000;
      for (let i = 0; i < 20 && Date.now() < deadline; i++) {
        if (p.A.syncManager.getDroppedCount() === 1) break;
        const before = attempts;
        await p.A.syncManager["commitQueue"].drain();
        await waitFor(
          () => attempts > before || p.A.syncManager.getPendingOps().length === 0,
          "commit attempts to advance after drain",
          5_000,
        );
      }

      // The op is dropped, not stuck in the queue.
      await waitFor(() => p.A.syncManager.getDroppedCount() === 1, "A's dropped count to be 1");
      assertEquals(p.A.syncManager.getPendingOps().length, 0, "no pending ops after the drop");

      // B never received the file.
      assertFalse(
        p.B.fakeVault.fileExists(path),
        "B must not have the file while A's commit is dropped",
      );

      // The last-backup stamp did not move during the failure, and the stamp
      // gate (what main.ts's onSyncCycleClean consults) refuses to stamp.
      assertEquals(lastBackupAt(p.A.state), stampBefore, "last-backup stamp must not move");
      assertFalse(
        shouldStampBackup({
          live: p.A.isLive(),
          dirty: 0,
          pending: p.A.syncManager.getPendingOps().length,
          dropped: p.A.syncManager.getDroppedCount(),
        }),
        "stamp gate must be false while ops are dropped",
      );

      // Fault clears: retryDropped() re-commits with a fresh retry budget.
      p.A.transport.commit = realCommit;
      await p.A.syncManager.retryDropped();

      assertEquals(p.A.syncManager.getDroppedCount(), 0, "dropped count returns to 0");
      await p.B.waitForVersion(path, 1, 30_000);
      assertEquals(
        new TextDecoder().decode(await p.B.fakeVault.readBinary(path)),
        "dropped content\n",
        "B receives the file content",
      );
      assert(
        shouldStampBackup({
          live: p.A.isLive(),
          dirty: 0,
          pending: p.A.syncManager.getPendingOps().length,
          dropped: p.A.syncManager.getDroppedCount(),
        }),
        "stamp gate is true after the dropped op commits",
      );
    } finally {
      await p.stop();
    }
  },
});
