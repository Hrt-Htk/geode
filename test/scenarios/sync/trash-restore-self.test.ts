import { assert, assertEquals } from "@std/assert";
import { pair, type TestServer, trashCount, versionCount } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";
import { restoreTrashOne } from "../../../plugin/plumbing/trash-client.ts";

// #687: a restore is credited to the device that asked for it. Until now the server
// invented a pseudo device for that, because a device never writes its own versions
// to disk. With the restored mark the requesting device applies it like any remote
// version: the file is back on every device, including the one that started it, and
// a replay after a reconnect writes it once.

const SETTLE_MS = 8_000;

interface ChainRow {
  version: number;
  deleted: number;
  device_id: string;
  restored: number;
}

function versionChain(
  server: TestServer,
  vaultId: string,
  pathHash: string,
): ChainRow[] {
  return server.db
    .prepare(
      "SELECT version, deleted, device_id, restored FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, pathHash) as ChainRow[];
}

/** Every conflict sibling on a vault: the restore must never leave one. */
function conflicts(vault: { fakeVault: { files: Map<string, unknown> } }): string[] {
  return [...vault.fakeVault.files.keys()].filter((path) => isConflictPath(path));
}

Deno.test({
  name: "trash-restore-self: the device that restores applies its own restored version",
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
      assertEquals(trashCount(server, vaultId), 1, "the delete left a trash entry");

      const pathHash = hashPathHex(A.keys!.mac_key, "x.md");
      // A restores its own deletion: the server credits the version to A itself.
      await restoreTrashOne(server.url, vaultId, A.pluginSettings.deviceToken, pathHash);

      await A.waitForVersion("x.md");
      await B.waitForVersion("x.md");
      await A.waitForConvergence(B, "x.md");

      const chain = versionChain(server, vaultId, pathHash);
      const head = chain.at(-1)!;
      assertEquals(head.deleted, 0, `server head is a delete: ${JSON.stringify(head)}`);
      assertEquals(head.device_id, A.pluginSettings.deviceId, "the requester is credited");
      assertEquals(head.restored, 1, "the head carries the restored mark");
      assertEquals(
        chain.filter((row) => row.version < head.version && row.restored === 1),
        [],
        "only the restore is marked",
      );

      assert(A.fakeVault.fileExists("x.md"), "the restoring device has the file back on disk");
      assert(B.fakeVault.fileExists("x.md"), "the peer has the file back on disk");
      assertEquals(
        new TextDecoder().decode(A.fakeVault.files.get("x.md")),
        "hello",
        "the restored content is the deleted content",
      );
      assertEquals(conflicts(A), [], "A has no conflict files");
      assertEquals(conflicts(B), [], "B has no conflict files");

      // A replay of the same version (a reconnect) must not write twice, conflict, or
      // commit a fresh version on top of the restore.
      const versionsBefore = versionCount(server, vaultId);
      await A.reconnect();
      await A.waitForIdle();
      await new Promise((r) => setTimeout(r, 2_000));

      assertEquals(
        versionCount(server, vaultId),
        versionsBefore,
        "no new version after the replay",
      );
      assertEquals(conflicts(A), [], "the replay creates no conflict file");
      assert(A.fakeVault.fileExists("x.md"), "the file survives the replay");
      assertEquals(
        new TextDecoder().decode(A.fakeVault.files.get("x.md")),
        "hello",
        "the replay does not rewrite the content",
      );
      assertEquals(
        A.state!.getLocalFile("x.md")!.last_seen_version,
        head.version,
        "the row still tracks the restored version",
      );

      // Nothing re-deleted it while the dust settled.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const settled = versionChain(server, vaultId, pathHash);
      assertEquals(
        settled.filter((row) => row.version > head.version),
        [],
        `a version appeared after the restore: ${JSON.stringify(settled)}`,
      );
      assert(A.fakeVault.fileExists("x.md"), "still on disk on A");
      assert(B.fakeVault.fileExists("x.md"), "still on disk on B");
    } finally {
      await stop();
    }
  },
});
