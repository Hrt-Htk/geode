import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Phase-1 catch-up replay coalescing (#283). On a reconnect-behind replay the
 * server replays every missed server_version; we want to collapse consecutive
 * already-missed versions per path_hash and apply only the LAST per path (the
 * only one that survives on disk): one reassemble+write, while still landing
 * a correct, contiguous last_seen_seq.
 */
Deno.test({
  name: "replay-coalescing - long backlog applies only the final version per path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Baseline: a single file both see, then B goes offline.
      A.fakeVault.write("doc.md", "v0");
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // Count B's reassemble fetches (getBlob) from here on. Every applied
      // version performs one fetch per chunk; each small edit is a single chunk.
      let blobGets = 0;
      const origGetBlob = B.transport.getBlob.bind(B.transport);
      B.transport.getBlob = (hash: string) => {
        blobGets++;
        return origGetBlob(hash);
      };

      B.disconnect();

      // A commits a long run of edits to the same file while B is offline.
      const total = 25;
      for (let i = 1; i <= total; i++) {
        A.fakeVault.write("doc.md", `edit ${i}`);
        await A.flushPending();
      }

      // B reconnects: server replays the missed window in seq order.
      await B.reconnect();
      await B.waitForVersion("doc.md", total + 1); // v0 + 25 edits = v26

      const content = new TextDecoder().decode(
        await B.fakeVault.readBinary("doc.md"),
      );
      assertEquals(content, `edit ${total}`);
      assertEquals(B.state.getLocalFile("doc.md")!.last_seen_version, total + 1);
      // Only the final version per path is reassembled (one write), not all 25.
      assertEquals(blobGets, 1, "replay must reassemble only the final version per path");
      // Persisted cursor is contiguous and at the top of the replay: nothing stranded.
      // In this clean harness each of the 26 commits occupies one monotonic seq, so the
      // winner's seq (the max replayed seq) is 26.
      assertEquals(B.state.getSyncCursor(), total + 1);
    } finally {
      await stop();
    }
  },
});

/**
 * Live is NOT coalesced: a version arriving while the transport is already live
 * applies immediately (one write, disk updated) rather than being deferred into
 * the replay buffer.
 */
Deno.test({
  name: "replay-coalescing - live messages apply immediately, not deferred",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("live.md", "base");
      await A.flushPending();
      await B.waitForVersion("live.md"); // B is now live & in sync

      // While B stays connected (live), A pushes another version.
      A.fakeVault.write("live.md", "updated");
      await A.flushPending();
      // waitForVersion polls the on-disk + local-state row; if the live version
      // were deferred into a never-drained buffer it would never land here.
      await B.waitForVersion("live.md", 2);

      const content = new TextDecoder().decode(
        await B.fakeVault.readBinary("live.md"),
      );
      assertEquals(content, "updated");
      assertEquals(B.state.getLocalFile("live.md")!.last_seen_version, 2);
    } finally {
      await stop();
    }
  },
});
