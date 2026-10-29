import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { triple } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

Deno.test({
  name:
    "merge-three-way-pingpong - three writers converge on non-overlapping edits within five versions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, C, server, vaultId, stop } = await triple();
    try {
      const path = "pingpong.md";

      A.fakeVault.write(path, "line 1\nline 2\nline 3\nline 4");
      await A.flushPending();
      await B.waitForVersion(path, 1);
      await C.waitForVersion(path, 1);

      B.disconnect();

      A.fakeVault.write(path, "A line 1\nline 2\nline 3\nline 4");
      await A.flushPending();

      B.fakeVault.files.set(path, new TextEncoder().encode("line 1\nB line 2\nline 3\nline 4"));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));
      await B.reconnect();
      await B.commitDirect(path);
      await A.waitForConvergence(B, path);
      await C.waitForVersion(path, 3);

      C.disconnect();

      A.fakeVault.write(path, "A line 1\nB line 2\nline 3\nA line 4");
      await A.flushPending();
      C.fakeVault.files.set(path, new TextEncoder().encode("A line 1\nB line 2\nC line 3\nline 4"));
      C.fakeVault.mtimes.set(path, Date.now() + 2_000);
      C.markLocalEdit(path);
      await C.reconnect();
      await C.waitForVersion(path, 5);

      await A.waitForConvergence(C, path);
      await B.waitForConvergence(C, path);
      C.clearLocalEdit(path);

      const finalContent = new TextDecoder().decode(await A.fakeVault.readBinary(path));
      assertEquals(finalContent, "A line 1\nB line 2\nC line 3\nA line 4");
      assertEquals(
        countServerVersions(server.db, vaultId, A.state.getLocalFile(path)!.path_hash),
        5,
      );
      assertEquals(conflictCount(A.fakeVault.files.keys()), 0);
      assertEquals(conflictCount(B.fakeVault.files.keys()), 0);
      assertEquals(conflictCount(C.fakeVault.files.keys()), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "merge-three-way-pingpong - overlapping edits settle on one canonical file plus conflict files",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, C, server, vaultId, stop } = await triple();
    try {
      const path = "overlap.md";

      A.fakeVault.write(path, "line 1\nshared line\nline 3");
      await A.flushPending();
      await B.waitForVersion(path, 1);
      await C.waitForVersion(path, 1);

      B.disconnect();
      C.disconnect();

      A.fakeVault.write(path, "line 1\nA wins\nline 3");
      await A.flushPending();

      B.fakeVault.files.set(path, new TextEncoder().encode("line 1\nB loses\nline 3"));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));
      await B.reconnect();
      await B.commitDirect(path);
      await waitForConflictFile(B, "overlap", ".md");

      C.fakeVault.files.set(path, new TextEncoder().encode("line 1\nC loses\nline 3"));
      C.fakeVault.mtimes.set(path, Date.now() + 2_000);
      C.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));
      await C.reconnect();
      await C.commitDirect(path);
      await waitForConflictFile(C, "overlap", ".md");

      assertEquals(
        new TextDecoder().decode(await A.fakeVault.readBinary(path)),
        "line 1\nA wins\nline 3",
      );
      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary(path)),
        "line 1\nA wins\nline 3",
      );
      assertEquals(
        new TextDecoder().decode(await C.fakeVault.readBinary(path)),
        "line 1\nA wins\nline 3",
      );
      assertEquals(
        countServerVersions(server.db, vaultId, A.state.getLocalFile(path)!.path_hash),
        2,
      );
      assertEquals(conflictCount(B.fakeVault.files.keys()), 1);
      assertEquals(conflictCount(C.fakeVault.files.keys()), 1);
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

function getCurrentSeq(db: Database, vaultId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?").get(
    vaultId,
  ) as
    | { seq: number | null }
    | undefined;
  return row?.seq ?? 0;
}

function conflictCount(paths: Iterable<string>): number {
  return [...paths].filter((path) => isConflictPath(path)).length;
}

async function waitForConflictFile(
  plugin: Awaited<ReturnType<typeof triple>>["A"],
  prefix: string,
  ext: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      [...plugin.fakeVault.files.keys()].some((path) =>
        path.startsWith(`${prefix} (conflict `) && path.endsWith(ext)
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for conflict file ${prefix}`);
}
