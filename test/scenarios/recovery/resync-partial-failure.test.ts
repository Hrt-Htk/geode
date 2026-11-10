// #54 review: a resync that dies AFTER it started applying must leave sync stopped. Its
// rows are open for files it never restored; a session restarted on them reads the missing
// files as deletes and removes them on the server (the mass-delete guard stays silent below
// 20 files). This is the server-truth proof: no delete version appears.
import { assertEquals, assertRejects } from "@std/assert";
import { rebuildVault, startRebuildTransport } from "../../../plugin/sync/rebuild-flow.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { pair, type TestPlugin, type TestServer } from "../../two-vault-driver.ts";

const PATHS = Array.from({ length: 24 }, (_, i) => `notes/n${String(i).padStart(2, "0")}.md`);
/** The three heads the rebuild cannot restore: their blobs are gone from the server. */
const LOST = PATHS.slice(0, 3);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pathHash(plugin: TestPlugin, path: string): string {
  return hashPathHex(plugin.keys!.mac_key, path);
}

function removeHeadBlobs(
  server: TestServer,
  vaultId: string,
  plugin: TestPlugin,
  paths: string[],
): void {
  for (const path of paths) {
    const row = server.db.prepare(
      `SELECT chunk_hashes FROM file_versions
       WHERE vault_id = ? AND path_hash = ? ORDER BY seq DESC LIMIT 1`,
    ).get(vaultId, pathHash(plugin, path)) as { chunk_hashes: string } | null;
    if (!row) throw new Error(`precondition: no head version for ${path}`);
    for (const hash of JSON.parse(row.chunk_hashes) as string[]) {
      Deno.removeSync(`${server.dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`);
    }
  }
}

function deletedVersions(
  server: TestServer,
  vaultId: string,
  plugin: TestPlugin,
  paths: string[],
): number {
  let count = 0;
  for (const path of paths) {
    count += (server.db.prepare(
      `SELECT COUNT(*) AS n FROM file_versions
       WHERE vault_id = ? AND path_hash = ? AND deleted = 1`,
    ).get(vaultId, pathHash(plugin, path)) as { n: number }).n;
  }
  return count;
}

Deno.test("resync - a partially applied rebuild sends no deletes and leaves sync stopped", async () => {
  const { A, B, server, vaultId, stop } = await pair();
  try {
    for (const [index, path] of PATHS.entries()) A.fakeVault.write(path, `note ${index}`);
    await A.flushPending();
    await B.waitForVersion(PATHS[PATHS.length - 1]);
    assertEquals(
      PATHS.filter((path) => B.fakeVault.files.has(path)).length,
      PATHS.length,
      "precondition: both devices hold all 24 files",
    );

    // The files went missing while the app was closed, and the server can no longer serve
    // three of the heads: the rebuild restores 21 and fails on 3.
    B.stop();
    for (const path of LOST) {
      B.fakeVault.files.delete(path);
      B.fakeVault.mtimes.delete(path);
    }
    removeHeadBlobs(server, vaultId, B, LOST);

    const transport = startRebuildTransport(B);
    try {
      await assertRejects(() => rebuildVault(B, transport), Error, "resync failed for");
    } finally {
      transport.stop();
    }

    // A restart, had it happened, reconciles within a moment: give the deletes their chance
    // to appear on the server before asserting that none did.
    await sleep(1_500);
    assertEquals(deletedVersions(server, vaultId, B, LOST), 0, "no delete reached the server");
    assertEquals(B.transport, null, "the failed rebuild leaves sync stopped");
    assertEquals(
      LOST.filter((path) => B.fakeVault.files.has(path)),
      [],
      "the unrestored files are still missing on disk, not deleted on the server",
    );
  } finally {
    await stop();
  }
});
