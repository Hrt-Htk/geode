import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-binary - binary conflicts keep the server winner and preserve the loser",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "attachment.pdf";
      const base = new Uint8Array([1, 2, 3, 4]);
      const serverWinner = new Uint8Array([5, 6, 7, 8]);
      const localLoser = new Uint8Array([9, 10, 11, 12]);

      A.fakeVault.writeBinary(path, base);
      await A.flushPending();
      await B.waitForVersion(path, 1);

      B.disconnect();

      A.fakeVault.writeBinary(path, serverWinner);
      await A.flushPending();

      B.fakeVault.files.set(path, new Uint8Array(localLoser));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));

      await B.reconnect();
      await B.commitDirect(path);
      await waitForConflictFile(B, "attachment", ".pdf");

      assertEquals(
        [...await B.fakeVault.readBinary(path)],
        [...serverWinner],
        "canonical binary should be the server winner",
      );

      const conflictPath = [...B.fakeVault.files.keys()].find((filePath) =>
        filePath.startsWith("attachment (conflict ") && filePath.endsWith(".pdf")
      );
      assertEquals(Boolean(conflictPath), true);
      assertEquals(
        [...await B.fakeVault.readBinary(conflictPath!)],
        [...localLoser],
        "conflict file should preserve the loser's bytes",
      );
    } finally {
      await stop();
    }
  },
});

function getCurrentSeq(db: Database, vaultId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?").get(
    vaultId,
  ) as
    | { seq: number | null }
    | undefined;
  return row?.seq ?? 0;
}

async function waitForConflictFile(
  plugin: Awaited<ReturnType<typeof pair>>["A"],
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
