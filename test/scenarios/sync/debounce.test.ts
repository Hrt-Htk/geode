import type { Database } from "@db/sqlite";
import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "debounce - repeated saves coalesce and pushNow flushes immediately",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "debounce.md";

      A.fakeVault.write(path, "initial");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      const pathHash = A.state.getLocalFile(path)!.path_hash;
      assertEquals(countServerVersions(server.db, vaultId, pathHash), 1);

      for (let index = 0; index < 20; index++) {
        A.fakeVault.write(path, `edit ${index}`);
      }

      assertEquals(
        A.eventHandler.getPendingOps().length,
        1,
        "debounce should coalesce pending ops",
      );
      await sleep(200);
      assertEquals(
        countServerVersions(server.db, vaultId, pathHash),
        1,
        "debounce window should prevent immediate commits",
      );

      const startedAt = Date.now();
      await A.pushNow();
      await B.waitForVersion(path, 2);

      assert(Date.now() - startedAt < 5_000, "pushNow should flush well before the 30s debounce");
      assertEquals(countServerVersions(server.db, vaultId, pathHash), 2);

      const finalContent = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(finalContent, "edit 19");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
