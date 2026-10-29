import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { runCompaction } from "../../../server/compaction.ts";

/**
 * #369: compaction deletes old version rows server-side, leaving seq gaps. A
 * device whose cursor is below such a gap used to stall forever: the server
 * replays only EXISTING seqs, so the missing gap seq is never delivered, and the
 * old contiguous-prefix cursor never advances past it: every reconnect re-replays
 * the tail (growing). The fix lets the cursor skip a seq that was never received
 * and is below a received (higher) seq, because the server streams ascending and
 * sends every existing seq, so that seq is permanently gone.
 *
 * Setup: A and B sync a.md (seq 1). B goes offline while A edits a.md three more
 * times (seqs 2,3,4). The server compacts (keeping root seq 1 and head seq 4,
 * deleting 2,3). B reconnects with cursor 1; the server replays only seq 4. The
 * cursor must reach the server's current seq (4), not stall at the gap.
 */
Deno.test({
  name: "cursor-compaction-gap - replay across a compacted seq gap reaches the current seq",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "v1");
      await A.flushPending();
      await B.waitForVersion("a.md");
      assertEquals(B.state.getSyncCursor(), 1, "baseline: B sees seq 1");

      B.disconnect();

      const edits = ["v2", "v3", "v4"];
      for (const content of edits) {
        A.fakeVault.write("a.md", content);
        await A.flushPending();
      }

      // Age every version beyond the 30-day floor, then compact. planCompaction
      // keeps root (seq 1) and head (seq 4) of a.md and deletes the middle 2,3.
      server.db.run(
        "UPDATE file_versions SET created_at = ? WHERE vault_id = ?",
        Date.now() - 40 * 24 * 3600 * 1000,
        vaultId,
      );
      await runCompaction(server.db, server.dataDir, vaultId);
      const current = server.db.prepare(
        "SELECT MAX(seq) AS m FROM file_versions WHERE vault_id = ?",
      ).get(vaultId) as { m: number };
      assertEquals(current.m, 4, "compaction kept seq 4 as the head");
      assertEquals(
        server.db.prepare(
          "SELECT COUNT(*) AS c FROM file_versions WHERE vault_id = ? AND seq IN (2,3)",
        ).get(vaultId) as { c: number },
        { c: 0 },
        "compaction deleted the middle seqs 2,3 -> permanent gap",
      );

      // Reconnect with cursor 1; the server replays only seq 4.
      await B.reconnect();
      await B.waitForSyncCursor(4);

      assertEquals(
        B.state.getSyncCursor(),
        current.m,
        "cursor reaches server current seq across the gap",
      );
      const content = new TextDecoder().decode(await B.fakeVault.readBinary("a.md"));
      assertEquals(content, "v4", "head content applied");
    } finally {
      await stop();
    }
  },
});
