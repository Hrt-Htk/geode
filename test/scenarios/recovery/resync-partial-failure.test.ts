// #54 review: a resync that dies AFTER it started applying leaves rows open for files it
// never restored. This is the server-truth proof for both ways the app comes back: nothing
// may read those rows as local deletes, not a session in the same process, not a reload,
// not a lock/unlock. The marker a partial rebuild persists is what keeps them stopped.
import { assertEquals, assertRejects } from "@std/assert";
import { rebuildVault, startRebuildTransport } from "../../../plugin/sync/rebuild-flow.ts";
import { hashPathHex } from "../../../core/hash.ts";
import {
  pair,
  restartPlugin,
  type TestPlugin,
  type TestServer,
  waitFor,
} from "../../two-vault-driver.ts";

const PATHS = Array.from({ length: 24 }, (_, i) => `notes/n${String(i).padStart(2, "0")}.md`);
/** The three heads the rebuild cannot restore: their blobs are moved out of the way. */
const LOST = PATHS.slice(0, 3);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pathHash(plugin: TestPlugin, path: string): string {
  return hashPathHex(plugin.keys!.mac_key, path);
}

/** Move the lost heads' blobs aside (restorable), so the rebuild cannot reassemble them. */
function hideHeadBlobs(
  server: TestServer,
  vaultId: string,
  plugin: TestPlugin,
  paths: string[],
): string[] {
  const hidden: string[] = [];
  for (const path of paths) {
    const row = server.db.prepare(
      `SELECT chunk_hashes FROM file_versions
       WHERE vault_id = ? AND path_hash = ? ORDER BY seq DESC LIMIT 1`,
    ).get(vaultId, pathHash(plugin, path)) as { chunk_hashes: string } | null;
    if (!row) throw new Error(`precondition: no head version for ${path}`);
    for (const hash of JSON.parse(row.chunk_hashes) as string[]) {
      const blob = `${server.dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`;
      const aside = `${blob}.hidden`;
      Deno.renameSync(blob, aside);
      hidden.push(aside);
    }
  }
  return hidden;
}

function restoreBlobs(hidden: string[]): void {
  for (const aside of hidden) Deno.renameSync(aside, aside.replace(/\.hidden$/, ""));
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

type Partial = {
  B: TestPlugin;
  server: TestServer;
  vaultId: string;
  hidden: string[];
  stop: () => Promise<void>;
};

/** Both devices hold 24 files, then B loses three files on disk and the server loses the
 * three heads: a rebuild restores 21 and fails on 3, after it has changed rows. */
async function partialRebuild(): Promise<Partial> {
  const { A, B, server, vaultId, stop } = await pair();
  for (const [index, path] of PATHS.entries()) A.fakeVault.write(path, `note ${index}`);
  await A.flushPending();
  await B.waitForVersion(PATHS[PATHS.length - 1]);
  assertEquals(
    PATHS.filter((path) => B.fakeVault.files.has(path)).length,
    PATHS.length,
    "precondition: both devices hold all 24 files",
  );

  B.stop();
  for (const path of LOST) {
    B.fakeVault.files.delete(path);
    B.fakeVault.mtimes.delete(path);
  }
  const hidden = hideHeadBlobs(server, vaultId, B, LOST);

  const transport = startRebuildTransport(B);
  try {
    await assertRejects(() => rebuildVault(B, transport), Error, "resync failed for");
  } finally {
    transport.stop();
  }
  return { B, server, vaultId, hidden, stop };
}

Deno.test("resync - a partial rebuild sends no deletes, and a reload does not start a session", async () => {
  const { B, server, vaultId, stop } = await partialRebuild();
  try {
    const reason = B.pluginSettings.resyncStop;
    assertEquals(reason.includes("resync failed for"), true, `the stop is persisted: ${reason}`);

    // A reload: a fresh plugin, the persisted rows and settings.
    const fresh = await restartPlugin(B, server);
    try {
      await sleep(1_500);
      assertEquals(fresh.transport, null, "no session starts on the rows the rebuild left");
      assertEquals(fresh.pluginSettings.resyncStop !== "", true, "the marker survives the reload");
      assertEquals(
        deletedVersions(server, vaultId, fresh, LOST),
        0,
        "no delete reached the server",
      );
    } finally {
      fresh.stop();
    }
  } finally {
    await stop();
  }
});

Deno.test("resync - the marker survives a lock and unlock, and a completed rebuild clears it", async () => {
  const { B, server, vaultId, hidden, stop } = await partialRebuild();
  try {
    // Lock, then unlock: the vault comes back unlocked (keys derived again) and sync stays
    // stopped, because the marker owns the rows the rebuild left open.
    B.stop();
    B.isUnlocked = false;
    B.keys = null;
    await B.start();
    await sleep(500);
    assertEquals(B.transport, null, "the marker keeps the session stopped after an unlock");
    assertEquals(deletedVersions(server, vaultId, B, LOST), 0, "no delete reached the server");

    // The retry: a transport of its own (a reload on the marker leaves none), then success.
    restoreBlobs(hidden);
    const transport = startRebuildTransport(B);
    try {
      await rebuildVault(B, transport);
    } finally {
      transport.stop();
    }
    await waitFor(() => B.isLive(), "the completed rebuild restarts the session");
    assertEquals(B.pluginSettings.resyncStop, "", "a completed rebuild clears the stop");
    assertEquals(deletedVersions(server, vaultId, B, LOST), 0, "no delete reached the server");
  } finally {
    await stop();
  }
});
