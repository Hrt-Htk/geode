import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";
import {
  pair,
  pathVersionCount,
  restartPlugin,
  type TestPlugin,
  versionCount,
  waitFor,
} from "../../two-vault-driver.ts";

// #59: an Android force-stop inside a download leaves a torn file and no row (rows
// persist on a throttle). On relaunch the reconciler read the fragment as a local
// create, the commit collided with the server head, and the merger kept the fragment
// as an empty "(conflict …)" file that then synced to every device. A batch now
// records its paths before its first write; the next start finishes the download.

const BODY = `# Shopping list

- milk
- bread
- butter
- apples
- two kinds of cheese, the good one
- something for the weekend
- coffee beans (the dark roast)
- olive oil
`;

const V1 = `# Meeting notes

Agenda item one.
Agenda item two.
Agenda item three.
Agenda item four.
Agenda item five.
Agenda item six.
`;

/** v2 rewrites the header and leaves the body alone: merging the truncated file against
 * it keeps the header, drops the body and commits that, which is silent data loss. */
const V2 = `# Meeting notes (revised)

Agenda item one.
Agenda item two.
Agenda item three.
Agenda item four.
Agenda item five.
Agenda item six.
`;

/** What the kill left: a note the batch was writing, and the update's header flushed. */
const FRAGMENT = "";
const UPDATE_FRAGMENT = "# Meeting notes\n\n";

const text = (
  bytes: Uint8Array | undefined,
) => (bytes ? new TextDecoder().decode(bytes) : "<gone>");

const conflictFiles = (plugin: TestPlugin) =>
  [...plugin.fakeVault.files.keys()].filter((path) => isConflictPath(path));

const identityHash = (path: string, content: string) =>
  blake3Hex(normalizeForHash(path, new TextEncoder().encode(content)));

/** The kill: the batch had recorded every path it was about to write, before writing. */
function recordInFlightBatch(plugin: TestPlugin, pathHashes: string[]): void {
  const cursorPath = plugin.pluginDataPath("sync-cursor.json");
  const persisted = plugin.fakeVault.pluginData.get(cursorPath);
  const cursor = persisted
    ? JSON.parse(new TextDecoder().decode(persisted))
    : { vault_id: "default" };
  cursor.in_flight_apply = pathHashes;
  plugin.fakeVault.pluginData.set(cursorPath, new TextEncoder().encode(JSON.stringify(cursor)));
}

/** The session starts its own reconciler after its drain: run a pass here so the
 * assertions never race that start. */
async function settle(plugin: TestPlugin): Promise<void> {
  await plugin.syncManager!.startReconciler();
  await plugin.reconcileNow();
}

/** The force-stop's leftovers: torn bytes on disk, mtime moved by the partial write. */
function leaveTornFile(plugin: TestPlugin, path: string, fragment = FRAGMENT): void {
  plugin.fakeVault.files.set(path, new TextEncoder().encode(fragment));
  plugin.fakeVault.mtimes.set(path, Date.now() + 5_000);
}

Deno.test({
  name: "interrupted-download - a torn create is finished from the server, not conflict-copied",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "torn-create.md";
      const pathHash = hashPathHex(B.keys!.mac_key, path);

      // The kill landed while B was downloading a note it had never seen: the server
      // holds it, B got no further than an empty file, and the row never persisted.
      B.stop();
      p.A.fakeVault.write(path, BODY);
      await p.A.flushPending();
      await waitFor(
        () => pathVersionCount(p.server, p.vaultId, pathHash) === 1,
        "the note on the server",
      );
      leaveTornFile(B, path);
      recordInFlightBatch(B, [pathHash]);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(1);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), BODY, "the server copy is written back");
      assertEquals(conflictFiles(B), [], "the fragment is never kept as a conflict copy");
      assertEquals(versionCount(p.server, p.vaultId), 1, "nothing extra is committed");
      assertEquals(B.syncManager!.getConflictCount(), 0);
      const row = B.state!.getLocalFile(path);
      assertEquals(row?.last_seen_version, 1, "the row is recorded at the head");
      assertEquals(row?.plaintext_hash, identityHash(path, BODY));
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

Deno.test({
  name: "interrupted-download - a torn update is finished from the server, not merged",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "torn-update.md";
      const pathHash = hashPathHex(B.keys!.mac_key, path);

      // v1 is on both devices and recorded in B's row.
      p.A.fakeVault.write(path, V1);
      await p.A.flushPending();
      await B.waitForVersion(path, 1);

      // B stops (its rows persist), the peer moves the note to v2, and the kill lands
      // inside that download: the row still says v1, the disk holds a torn file.
      B.stop();
      p.A.fakeVault.write(path, V2);
      await p.A.flushPending();
      await waitFor(
        () => pathVersionCount(p.server, p.vaultId, pathHash) === 2,
        "the peer's second version",
      );
      leaveTornFile(B, path, UPDATE_FRAGMENT);
      recordInFlightBatch(B, [pathHash]);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(2);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), V2, "the head lands, nothing is merged in");
      assertEquals(conflictFiles(B), [], "no conflict copy of the fragment");
      assertEquals(versionCount(p.server, p.vaultId), 2, "the fragment is never committed");
      const row = B.state!.getLocalFile(path);
      assertEquals(row?.last_seen_version, 2, "the row follows the head");
      assertEquals(row?.plaintext_hash, identityHash(path, V2));
      assertEquals(B.syncManager!.getConflictCount(), 0);

      // Nothing the fragment produced may reach the peer.
      await p.A.waitForCaughtUp(2);
      await settle(p.A);
      assertEquals(text(p.A.fakeVault.files.get(path)), V2, "the peer's note is untouched");
      assertEquals(conflictFiles(p.A), []);
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});
