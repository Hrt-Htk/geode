import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "binary-conflict - losing local image is preserved as a conflict file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "image.png";
      const base = new Uint8Array([1, 2, 3, 4, 5]);
      const serverWinner = new Uint8Array([6, 7, 8, 9, 10]);
      const localLoser = new Uint8Array([11, 12, 13, 14, 15]);

      A.fakeVault.writeBinary(path, base);
      await A.flushPending();
      await B.waitForVersion(path, 1);

      A.disconnect();

      B.fakeVault.writeBinary(path, serverWinner);
      await B.flushPending();

      A.fakeVault.files.set(path, new Uint8Array(localLoser));
      A.fakeVault.mtimes.set(path, Date.now() + 1_000);
      A.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));

      await A.reconnect();
      await A.commitDirect(path);
      await waitForConflictFile(A, "image", ".png");

      assertEquals([...await A.fakeVault.readBinary(path)], [...serverWinner]);

      const conflictPath = [...A.fakeVault.files.keys()].find((filePath) =>
        filePath.startsWith("image (conflict ") && filePath.endsWith(".png")
      );
      assertEquals(Boolean(conflictPath), true);
      assertEquals([...await A.fakeVault.readBinary(conflictPath!)], [...localLoser]);
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
