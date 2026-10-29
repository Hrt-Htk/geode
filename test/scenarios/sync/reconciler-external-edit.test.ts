import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "reconciler-external-edit - external create/modify/delete sync and touch is a no-op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const trackedPath = "tracked.md";
      const createdPath = "created-externally.md";

      A.fakeVault.write(trackedPath, "original");
      await A.flushPending();
      await B.waitForVersion(trackedPath, 1);

      const trackedHash = A.state.getLocalFile(trackedPath)!.path_hash;
      const touchedMtime = (A.fakeVault.mtimes.get(trackedPath) ?? 0) + 1_000;

      A.fakeVault.files.set(trackedPath, new TextEncoder().encode("original"));
      A.fakeVault.mtimes.set(trackedPath, touchedMtime);
      await A.reconcileNow();

      assertEquals(countServerVersions(server.db, vaultId, trackedHash), 1);
      assertEquals(A.state.getLocalFile(trackedPath)!.mtime, touchedMtime);
      assertEquals(B.state.getLocalFile(trackedPath)!.last_seen_version, 1);

      A.fakeVault.files.set(trackedPath, new TextEncoder().encode("modified outside events"));
      A.fakeVault.mtimes.set(trackedPath, touchedMtime + 1);
      await A.reconcileNow();
      await B.waitForVersion(trackedPath, 2);

      const modified = new TextDecoder().decode(await B.fakeVault.readBinary(trackedPath));
      assertEquals(modified, "modified outside events");

      A.fakeVault.files.set(createdPath, new TextEncoder().encode("created outside events"));
      A.fakeVault.mtimes.set(createdPath, touchedMtime + 2);
      await A.reconcileNow();
      await B.waitForVersion(createdPath, 1);

      const created = new TextDecoder().decode(await B.fakeVault.readBinary(createdPath));
      assertEquals(created, "created outside events");

      A.fakeVault.files.delete(trackedPath);
      A.fakeVault.mtimes.delete(trackedPath);
      await A.reconcileNow();
      await B.waitForDeleted(trackedPath);

      assertEquals(B.fakeVault.fileExists(trackedPath), false);
    } finally {
      await stop();
    }
  },
});

function countServerVersions(db: Database, vaultId: string, pathHash: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM file_versions WHERE vault_id = ? AND path_hash = ?",
  ).get(vaultId, pathHash) as { count: number } | undefined;
  return row?.count ?? 0;
}
