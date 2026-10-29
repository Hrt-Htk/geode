import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-both-create-same-path - independent creates surface a conflict file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/new.md";

      B.disconnect();

      A.fakeVault.write(path, "created by A");
      await A.flushPending();

      B.fakeVault.files.set(path, new TextEncoder().encode("created by B"));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));

      await B.reconnect();
      await B.commitDirect(path);
      await waitForConflictFile(B, "notes/new");

      const canonical = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(canonical, "created by A");

      const conflictFiles = [...B.fakeVault.files.keys()].filter((filePath) =>
        filePath.startsWith("notes/new (conflict ") && filePath.endsWith(".md")
      );
      assertEquals(conflictFiles.length, 1);

      const conflictBody = new TextDecoder().decode(await B.fakeVault.readBinary(conflictFiles[0]));
      assertEquals(conflictBody, "created by B");
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
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (
      [...plugin.fakeVault.files.keys()].some((path) => path.startsWith(`${prefix} (conflict `))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout waiting for conflict file ${prefix}`);
}
