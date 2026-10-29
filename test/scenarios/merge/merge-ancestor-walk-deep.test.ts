import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-ancestor-walk-deep - deep version chains still merge from the right ancestor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "deep.md";
      const baseLines = ["A version 1", "line 2", "line 3", "line 4", "line 5"];

      A.fakeVault.write(path, baseLines.join("\n"));
      await A.flushPending();
      await B.waitForVersion(path, 1);

      const pathHash = A.state.getLocalFile(path)!.path_hash;

      for (let version = 2; version <= 5; version++) {
        A.fakeVault.write(path, [`A version ${version}`, ...baseLines.slice(1)].join("\n"));
        await A.flushPending();
        await B.waitForVersion(path, version);
      }

      B.disconnect();

      for (let version = 6; version <= 50; version++) {
        A.fakeVault.write(path, [`A version ${version}`, ...baseLines.slice(1)].join("\n"));
        await A.flushPending();
        // flushPending waits a fixed 500ms and doesn't await the async commit
        // chain, so on a slow runner the next write can start while the previous
        // commit is still in-flight (commitOp's in-flight guard then drops it).
        // Poll the server db to guarantee each A version is a distinct row before
        // the next write.
        await waitForServerCount(server.db, vaultId, pathHash, version);
      }

      B.fakeVault.files.set(
        path,
        new TextEncoder().encode("A version 5\nline 2\nline 3\nline 4\nB offline edit"),
      );
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));

      await B.reconnect();
      await B.commitDirect(path);
      await A.waitForConvergence(B, path);

      const finalContent = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(finalContent, "A version 50\nline 2\nline 3\nline 4\nB offline edit");
      assertEquals(
        countServerVersions(server.db, vaultId, A.state.getLocalFile(path)!.path_hash),
        51,
      );
    } finally {
      await stop();
    }
  },
});

async function waitForServerCount(
  db: Database,
  vaultId: string,
  pathHash: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (countServerVersions(db, vaultId, pathHash) >= expected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${expected} server versions of ${pathHash}`);
}

function countServerVersions(db: Database, vaultId: string, pathHash: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM file_versions WHERE vault_id = ? AND path_hash = ?",
  ).get(vaultId, pathHash) as { count: number } | undefined;
  return row?.count ?? 0;
}

function getCurrentSeq(db: Database, vaultId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?").get(
    vaultId,
  ) as
    | { seq: number | null }
    | undefined;
  return row?.seq ?? 0;
}
