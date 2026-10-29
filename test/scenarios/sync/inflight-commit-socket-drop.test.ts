import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";
import type { CommitRequest } from "../../../plugin/sync/commit-channel.ts";

const decoder = new TextDecoder();

// #616: the server can record a commit whose ack the client never sees (the
// socket dies, or the ack is lost). The op is retried, and that resend must not
// write the edit twice: the server answers `parent_mismatch` for the version it
// already holds (server/ws.ts applyCommit), and the conflict handler resolves an
// identical, self-authored head as a no-op.
//
// Fault seam is the transport's commit boundary, exactly as dropped-commit-retry
// does: the real commit (chunking, encryption, blob upload, server insert) runs;
// only the result the queue sees is the "socket closed" the drop produces.
Deno.test({
  name:
    "inflight-commit-socket-drop - a lost ack for an applied commit is retried without a second version",
  sanitizeOps: false,
  sanitizeResources: false,
  timeout: 60_000,
  async fn() {
    const p = await pair();
    try {
      const path = "notes/inflight-drop.md";
      const body = "edited while the socket was dying\n";
      p.A.fakeVault.write(path, "baseline\n");
      await p.A.flushPending();
      await p.A.waitForConvergence(p.B, path);

      const pathHash = hashPathHex(p.A.keys!.mac_key, path);
      const versions = () =>
        (p.server.db.prepare(
          "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
        ).get(p.vaultId, pathHash) as { n: number }).n;
      assertEquals(versions(), 1, "baseline commit landed");

      // The socket dies with the ack in flight: the server keeps the version, the
      // queue only sees the failure.
      const realCommit = p.A.transport.commit.bind(p.A.transport);
      let lostAcks = 0;
      p.A.transport.commit = (req: CommitRequest) => {
        if (lostAcks > 0) return realCommit(req);
        lostAcks++;
        void realCommit(req);
        return Promise.resolve({ kind: "error", message: "socket closed" } as const);
      };

      p.A.fakeVault.write(path, body);
      await p.A.pushNow();
      assertEquals(lostAcks, 1, "the edit was committed over the dying socket");
      assertEquals(p.A.syncManager.getPendingOps().length, 0, "the queue drains after the resend");

      await p.A.waitForConvergence(p.B, path);
      assertEquals(decoder.decode(p.B.fakeVault.files.get(path)!), body, "the edit reached B");
      assertEquals(decoder.decode(p.A.fakeVault.files.get(path)!), body, "A keeps its edit");
      assertEquals(versions(), 2, "the resend must not write a second version of the edit");
      assertEquals(
        [...p.A.fakeVault.files.keys()].filter(isConflictPath).length,
        0,
        "an already-applied commit resolves as a no-op, not a conflict file",
      );
    } finally {
      await p.stop();
    }
  },
});
