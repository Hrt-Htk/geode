import { assert, assertEquals } from "@std/assert";
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

// #59: an Android force-stop inside a download leaves a torn file and no row (rows persist
// on a throttle). On relaunch the reconciler read the fragment as a local create, the
// commit collided with the server head, and the merger kept the fragment as an empty
// "(conflict …)" file that then synced to every device. The update case is worse: a
// fragment that is a prefix of the note merges 3-way against the new head cleanly and
// commits the loss.
//
// The kill is simulated where it really happens: inside the vault write, with the write
// leaving a fragment on disk and the process dying before its row persists. Nothing here
// hand-writes the in-flight record: the code under test writes it, and the test only reads
// what a kill left behind in the plugin data.

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

const SECOND = `# Second note

The download of this one is killed in the same batch as the first.
`;

/** A note the kill reached: the write landed a few bytes, nothing else. */
const FRAGMENT = "# Mee";

const UPDATE_FRAGMENT = "# Meeting notes\n\n";

const text = (
  bytes: Uint8Array | undefined,
) => (bytes ? new TextDecoder().decode(bytes) : "<gone>");

const conflictFiles = (plugin: TestPlugin) =>
  [...plugin.fakeVault.files.keys()].filter((path) => isConflictPath(path));

const identityHash = (path: string, content: string) =>
  blake3Hex(normalizeForHash(path, new TextEncoder().encode(content)));

/** What a kill left in the plugin data: the record is written by the plugin, never by a test. */
function persistedRecord(plugin: TestPlugin): string[] {
  const raw = plugin.fakeVault.pluginData.get(plugin.pluginDataPath("sync-cursor.json"));
  if (!raw) return [];
  const cursor = JSON.parse(new TextDecoder().decode(raw)) as { in_flight_apply?: string[] };
  return cursor.in_flight_apply ?? [];
}

/** Kill the app inside the write of `path`: the native write leaves `bytes` on disk and
 * the process dies before the row persists (the adapter throws, as a dead bridge would).
 * The bridge stays dead for that path, so the write helper's fallback throws too. */
function killOnWrite(
  path: string,
  bytes: Uint8Array,
  onKill: () => void,
): (plugin: TestPlugin) => void {
  return (plugin) => {
    const writeBinary = plugin.fakeVault.writeBinary.bind(plugin.fakeVault);
    plugin.fakeVault.writeBinary = (p: string, data: Uint8Array, opts?: { mtime?: number }) => {
      if (p !== path) return writeBinary(p, data, opts);
      plugin.fakeVault.files.set(p, new Uint8Array(bytes));
      plugin.fakeVault.mtimes.set(p, Date.now());
      onKill();
      throw new Error("the app was killed inside the write");
    };
  };
}

/** The row as the last kill left it in the plugin data (the state is gone after a stop). */
function persistedRow(plugin: TestPlugin, path: string): { last_seen_version: number } | null {
  const raw = plugin.fakeVault.pluginData.get(plugin.pluginDataPath("local-files.json"));
  if (!raw) return null;
  const rows = JSON.parse(new TextDecoder().decode(raw)) as Array<{
    path: string;
    last_seen_version: number;
  }>;
  return rows.find((row) => row.path === path) ?? null;
}

Deno.test({
  name: "interrupted-download - a batch killed mid-write finishes the download on the next start",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "torn-create.md";
      const pathHash = hashPathHex(B.keys!.mac_key, path);

      // The note reaches the server while B is closed, so its download is a catch-up.
      B.stop();
      p.A.fakeVault.write(path, BODY);
      await p.A.flushPending();
      await waitFor(
        () => pathVersionCount(p.server, p.vaultId, pathHash) === 1,
        "the note on the server",
      );

      let killed = false;
      B = await restartPlugin(B, p.server, {
        prepare: killOnWrite(path, new TextEncoder().encode(FRAGMENT), () => {
          killed = true;
        }),
      });
      await waitFor(() => killed, "the drain to die inside the write");
      B.stop();

      // The batch recorded the path before writing it, and the row never landed.
      assertEquals(persistedRecord(B), [pathHash], "the killed batch left its record");
      assertEquals(persistedRow(B, path), null, "no row survived the kill");
      assertEquals(text(B.fakeVault.files.get(path)), FRAGMENT);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(1);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), BODY, "the server copy is written back");
      assertEquals(conflictFiles(B), [], "the fragment is never kept as a conflict copy");
      assertEquals(versionCount(p.server, p.vaultId), 1, "nothing extra is committed");
      assertEquals(B.syncManager!.getConflictCount(), 0);
      assertEquals(persistedRecord(B), [], "the record is cleared once the download finished");
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
  name: "interrupted-download - a killed update is finished from the server, not merged",
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

      // B closes (its rows persist), the peer moves the note to v2, and the download of
      // v2 is killed inside the write: the row still says v1, the disk holds a fragment.
      B.stop();
      p.A.fakeVault.write(path, V2);
      await p.A.flushPending();
      await waitFor(
        () => pathVersionCount(p.server, p.vaultId, pathHash) === 2,
        "the peer's second version",
      );

      let killed = false;
      B = await restartPlugin(B, p.server, {
        prepare: killOnWrite(path, new TextEncoder().encode(UPDATE_FRAGMENT), () => {
          killed = true;
        }),
      });
      await waitFor(() => killed, "the drain to die inside the write");
      B.stop();

      assertEquals(persistedRecord(B), [pathHash], "the killed batch left its record");
      assertEquals(persistedRow(B, path)?.last_seen_version, 1, "the row still says v1");
      assertEquals(text(B.fakeVault.files.get(path)), UPDATE_FRAGMENT);

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

Deno.test({
  name: "interrupted-download - one path of a killed batch fails: only it stays recorded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const first = "batch-first.md";
      const second = "batch-second.md";
      const firstHash = hashPathHex(B.keys!.mac_key, first);

      // Both notes reach the server while B is closed: one replay batch of two files.
      B.stop();
      p.A.fakeVault.write(first, BODY);
      p.A.fakeVault.write(second, SECOND);
      await p.A.flushPending();
      await waitFor(
        () => versionCount(p.server, p.vaultId) === 2,
        "both notes on the server",
      );

      // The kill lands inside the first file of the batch: it is torn, the second one is
      // never written, and no row for either survived.
      let killed = false;
      B = await restartPlugin(B, p.server, {
        prepare: killOnWrite(first, new TextEncoder().encode(FRAGMENT), () => {
          killed = true;
        }),
      });
      await waitFor(() => killed, "the drain to die inside the write");
      B.stop();
      assert(
        persistedRecord(B).includes(firstHash),
        "the batch recorded the path before writing it",
      );

      // The next start re-downloads both; the first one's write dies again (a device whose
      // bridge keeps failing), the second one lands.
      let killedAgain = false;
      B = await restartPlugin(B, p.server, {
        prepare: killOnWrite(first, new TextEncoder().encode(FRAGMENT), () => {
          killedAgain = true;
        }),
      });
      await waitFor(() => killedAgain, "the re-download to die inside the write");
      await B.waitForCaughtUp(2);
      await settle(B);

      assertEquals(
        text(B.fakeVault.files.get(second)),
        SECOND,
        "the other file of the batch landed",
      );
      assertEquals(B.state!.getLocalFile(second)?.last_seen_version, 1);
      assertEquals(persistedRecord(B), [firstHash], "the failed path alone stays recorded");
      assertEquals(text(B.fakeVault.files.get(first)), FRAGMENT, "its fragment is left alone");
      assertEquals(
        B.state!.getLocalFile(first) ?? null,
        null,
        "a fragment held by a record gets no row (nothing commits it)",
      );
      assertEquals(conflictFiles(B), [], "no conflict copy of the fragment");
      assertEquals(versionCount(p.server, p.vaultId), 2, "the fragment is never committed");

      // The record is stuck, not lost: the next start finishes it once the write works.
      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(2);
      await settle(B);
      assertEquals(text(B.fakeVault.files.get(first)), BODY, "the head lands at last");
      assertEquals(persistedRecord(B), []);
      assertEquals(versionCount(p.server, p.vaultId), 2, "still nothing extra committed");
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

/** The session starts its own reconciler after its drain: run a pass here so the
 * assertions never race that start. */
async function settle(plugin: TestPlugin): Promise<void> {
  await plugin.syncManager!.startReconciler();
  await plugin.reconcileNow();
}
