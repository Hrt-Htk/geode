import { assert, assertEquals } from "@std/assert";
import { pair, type TestServer } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { restoreTrashOne } from "../../../plugin/plumbing/trash-client.ts";

const SLEEP_MS = 8_000;

interface ChainRow {
  version: number;
  deleted: number;
  device_id: string;
}

function versionChain(
  server: TestServer,
  vaultId: string,
  pathHash: string,
): ChainRow[] {
  return server.db
    .prepare(
      "SELECT version, deleted, device_id FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, pathHash) as ChainRow[];
}

/** Poll the server chain for `sleepMs`; a restore must not be followed by a
 * new delete version (the deleter re-committing its stale delete). */
async function assertNoLateDelete(
  server: TestServer,
  vaultId: string,
  pathHash: string,
  restoredVersion: number,
  sleepMs: number,
): Promise<ChainRow[]> {
  await new Promise((r) => setTimeout(r, sleepMs));
  const chain = versionChain(server, vaultId, pathHash);
  const lateDeletes = chain.filter((v) => v.version > restoredVersion && v.deleted === 1);
  assertEquals(
    lateDeletes,
    [],
    `a delete version appeared after the restore (v${restoredVersion}): ${
      JSON.stringify(lateDeletes)
    }`,
  );
  const head = chain[chain.length - 1];
  assertEquals(head.deleted, 0, `server head is a delete: ${JSON.stringify(head)}`);
  return chain;
}

Deno.test({
  name: "trash-restore-sticks: restore from B sticks on A (the deleter)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "hello");
      await A.flushPending();
      await A.waitForConvergence(B, "x.md");
      await B.waitForConvergence(A, "x.md");

      await A.fakeVault.delete("x.md");
      await A.flushPending();
      await A.waitForDeleted("x.md");
      await B.waitForDeleted("x.md");

      const pathHash = hashPathHex(A.keys.mac_key, "x.md");
      await restoreTrashOne(server.url, vaultId, B.settings.deviceToken, pathHash);

      await A.waitForConvergence(B, "x.md");
      await A.waitForVersion("x.md");
      await B.waitForVersion("x.md");

      const restoredVersion = versionChain(server, vaultId, pathHash).at(-1)!.version;
      await assertNoLateDelete(server, vaultId, pathHash, restoredVersion, SLEEP_MS);

      assert(A.fakeVault.fileExists("x.md"), "file missing on A after settle");
      assert(B.fakeVault.fileExists("x.md"), "file missing on B after settle");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "trash-restore-sticks: a stale requeued delete op does not re-trash a restored file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "hello");
      await A.flushPending();
      await A.waitForConvergence(B, "x.md");
      await B.waitForConvergence(A, "x.md");

      await A.fakeVault.delete("x.md");
      await A.flushPending();
      await A.waitForDeleted("x.md");
      await B.waitForDeleted("x.md");

      const pathHash = hashPathHex(A.keys.mac_key, "x.md");
      await restoreTrashOne(server.url, vaultId, B.settings.deviceToken, pathHash);
      await A.waitForConvergence(B, "x.md");
      await A.waitForVersion("x.md");
      await B.waitForVersion("x.md");
      const restoredVersion = versionChain(server, vaultId, pathHash).at(-1)!.version;

      // The real-world trigger: A's original delete commit reached the server
      // but its ack was lost (socket closed / commit timeout), so the delete op
      // was requeued in A's commit queue. By the time the restored head has been
      // applied (row non-deleted, file back on disk), that stale op is still
      // queued. Draining it must NOT commit a new delete over the restore.
      await A.syncManager.handlePendingOps([{ path: "x.md", kind: "delete" }]);

      await assertNoLateDelete(server, vaultId, pathHash, restoredVersion, SLEEP_MS);
      assert(A.fakeVault.fileExists("x.md"), "restored file re-deleted on A");
      assert(B.fakeVault.fileExists("x.md"), "restored file re-deleted on B");
    } finally {
      await stop();
    }
  },
});
