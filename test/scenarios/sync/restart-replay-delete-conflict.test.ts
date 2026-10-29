import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Issue #283: coalesced replay must not let a DELETE winner silently destroy an
 * untracked local edit.
 *
 * When B has an untracked local edit (direct disk write bypassing events), then
 * goes offline while peer A pushes several content versions of the same path and
 * finally deletes it, B's reconnect replays the whole window and coalesces it to
 * a single DELETE winner (`supersededSeqs.length > 0`). The delete route never
 * inspects the disk, so without a re-surface the local edit is silently removed.
 *
 * The fix must promote the divergent disk edit to a tracked local edit BEFORE
 * applying the delete winner, so applyVersion's deleted branch routes to
 * onConflict and the local content survives (local-wins clean merge) instead of
 * being deleted.
 */
Deno.test({
  name: "restart-replay-delete-conflict - coalesced delete winner preserves untracked local edit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "notes/doc.md";

      // A creates, B receives: baseline in sync.
      A.fakeVault.write(path, "line1\nline2\nline3\n");
      await A.flushPending();
      await B.waitForVersion(path);

      // B makes an untracked local edit (bypassing events, like lockVault + direct
      // write): NOT in pendingOps / localEditPaths.
      B.fakeVault.files.set(path, new TextEncoder().encode("line1\nLOCAL EDIT\nline3\n"));

      // B goes offline while A pushes several content versions then deletes P.
      B.disconnect();
      A.fakeVault.write(path, "edit 1\n");
      await A.flushPending();
      A.fakeVault.write(path, "edit 2\n");
      await A.flushPending();
      A.fakeVault.write(path, "edit 3\n");
      await A.flushPending();
      A.fakeVault.delete(path);
      await A.flushPending();

      // B reconnects: the whole window replays and coalesces to a single DELETE
      // winner with superseded content seqs.
      await B.reconnect();
      await sleep(2000);

      // B's untracked local edit must survive: it must NOT be silently deleted.
      const conflictCount = B.syncManager.getConflictCount();
      const conflictFiles = [...B.fakeVault.files.keys()].filter((k) => isConflictPath(k));
      const survivedBody = B.fakeVault.files.has(path)
        ? new TextDecoder().decode(B.fakeVault.files.get(path))
        : null;

      assertEquals(
        survivedBody !== null && survivedBody.includes("LOCAL EDIT"),
        true,
        `B's untracked local edit must survive the coalesced delete replay. ` +
          `path exists: ${B.fakeVault.files.has(path)}, conflict count: ${conflictCount}, ` +
          `conflict files: ${conflictFiles.join(", ")}. Silent delete = data loss.`,
      );
    } finally {
      await stop();
    }
  },
});
