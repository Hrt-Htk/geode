import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { decryptMetadata } from "../../../core/crypto.ts";
import { reassemble } from "../../../core/reassemble.ts";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "merge-no-marker-commit - marker-producing merges never commit marker content",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "markers.md";

      A.fakeVault.write(path, "line 1\nshared line\nline 3");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      B.disconnect();

      A.fakeVault.write(path, "line 1\nA edit\nline 3");
      await A.flushPending();

      B.fakeVault.files.set(path, new TextEncoder().encode("line 1\nB edit\nline 3"));
      B.fakeVault.mtimes.set(path, Date.now() + 1_000);
      B.state.updateSyncCursor(getCurrentSeq(server.db, vaultId));

      await B.reconnect();
      await B.commitDirect(path);
      await waitForConflictFile(B, "markers");

      const pathHash = A.state.getLocalFile(path)!.path_hash;
      const versions = server.db.prepare(
        `SELECT version, enc_metadata, chunk_hashes
         FROM file_versions
         WHERE vault_id = ? AND path_hash = ?
         ORDER BY version`,
      ).all(vaultId, pathHash) as Array<{
        version: number;
        enc_metadata: Uint8Array;
        chunk_hashes: string;
      }>;

      assertEquals(versions.length, 2);

      for (const version of versions) {
        const metadata = await decryptMetadata(version.enc_metadata, A.keys, pathHash);
        const content = new TextDecoder().decode(
          await reassemble(
            JSON.parse(version.chunk_hashes),
            A.keys,
            (hash) => A.transport.getBlob(hash),
            metadata.plaintext_hash,
          ),
        );
        assertEquals(
          content.includes("<<<<<<<"),
          false,
          `version ${version.version} committed conflict markers`,
        );
        assertEquals(
          content.includes("======="),
          false,
          `version ${version.version} committed conflict markers`,
        );
        assertEquals(
          content.includes(">>>>>>>"),
          false,
          `version ${version.version} committed conflict markers`,
        );
      }

      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary(path)),
        "line 1\nA edit\nline 3",
      );
      assertEquals(
        [...B.fakeVault.files.keys()].filter((filePath) =>
          filePath.startsWith("markers (conflict ")
        )
          .length,
        1,
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
