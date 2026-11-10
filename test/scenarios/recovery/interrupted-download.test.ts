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
// "(conflict ...)" file that then synced to every device. The update case is worse: a
// fragment that is a prefix of the note merges 3-way against the new head cleanly and
// commits the loss.
//
// The kill is simulated where it really happens: inside the vault write, with the write
// leaving a fragment on disk and the process dying before the record is cleared. Nothing
// here hand-writes the record: the code under test writes it, and the test only reads what
// the kill left behind plus what the next start does with it.

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

/** v2 rewrites the header and leaves the body alone: merging the truncated file against it
 * keeps the header, drops the body and commits that, which is silent data loss. */
const V2 = `# Meeting notes (revised)

Agenda item one.
Agenda item two.
Agenda item three.
Agenda item four.
Agenda item five.
Agenda item six.
`;

/** What the kill left: a torn write leaves the first bytes of what it was writing. */
const FRAGMENT = BODY.slice(0, 5);
const UPDATE_FRAGMENT = V2.slice(0, 20);

const text = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder().decode(bytes) : "<gone>";

const conflictFiles = (plugin: TestPlugin) =>
  [...plugin.fakeVault.files.keys()].filter((path) => isConflictPath(path));

const identityHash = (path: string, content: string) =>
  blake3Hex(normalizeForHash(path, new TextEncoder().encode(content)));

/** The record as the plugin data holds it: written by the plugin, never by a test. */
function persistedRecord(
  plugin: TestPlugin,
): Array<{ path: string; expected_plaintext_hash: string }> {
  const raw = plugin.fakeVault.pluginData.get(plugin.pluginDataPath("sync-cursor.json"));
  if (!raw) return [];
  const cursor = JSON.parse(new TextDecoder().decode(raw)) as {
    in_flight_apply?: Array<{ path: string; expected_plaintext_hash: string }>;
  };
  return cursor.in_flight_apply ?? [];
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

/** Kill the app inside the write of `path`: the native write leaves `bytes` on disk and the
 * process dies (the bridge throws and stays dead for that path). */
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

/** A kill that lands between the record and the write: the bridge fails before any byte. */
function failBeforeWrite(path: string, onFail: () => void): (plugin: TestPlugin) => void {
  return (plugin) => {
    const writeBinary = plugin.fakeVault.writeBinary.bind(plugin.fakeVault);
    plugin.fakeVault.writeBinary = (p: string, data: Uint8Array, opts?: { mtime?: number }) => {
      if (p !== path) return writeBinary(p, data, opts);
      onFail();
      throw new Error("the bridge died before the write");
    };
  };
}

/** The session starts its own reconciler after its drain: run a pass here so the assertions
 * never race that start. */
async function settle(plugin: TestPlugin): Promise<void> {
  await plugin.syncManager!.startReconciler();
  await plugin.reconcileNow();
}

Deno.test({
  name: "interrupted-download - a kill mid download finishes it on the next start",
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

      const record = persistedRecord(B);
      assertEquals(record.map((entry) => entry.path), [path], "the killed write is recorded");
      assertEquals(
        record[0].expected_plaintext_hash,
        identityHash(path, BODY),
        "the record says what the write was meant to leave",
      );
      assertEquals(persistedRow(B, path), null, "no row survived the kill");
      assertEquals(text(B.fakeVault.files.get(path)), FRAGMENT);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(1);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), BODY, "the server copy is written back");
      assertEquals(conflictFiles(B), [], "the fragment is never kept as a conflict copy");
      assertEquals(versionCount(p.server, p.vaultId), 1, "nothing extra is committed");
      assertEquals(B.syncManager!.getConflictCount(), 0);
      assertEquals(persistedRecord(B), [], "the record is cleared once resolved");
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

      // B closes (its rows persist), the peer moves the note to v2, and the download of v2
      // is killed inside the write: the row still says v1, the disk holds a fragment.
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

      assertEquals(persistedRecord(B).map((entry) => entry.path), [path]);
      assertEquals(persistedRow(B, path)?.last_seen_version, 1, "the row still says v1");
      assertEquals(text(B.fakeVault.files.get(path)), UPDATE_FRAGMENT);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(2);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), V2, "the head lands, nothing is merged");
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
  name: "interrupted-download - a killed conflict sibling is removed, never synced",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "sibling.md";
      const edit = "# Mine\n\nmy local edit\n";

      // A note both devices have, then B edits it off the event stream and A raises a
      // divergent version: B's apply conflicts and writes a conflict sibling first.
      p.A.fakeVault.write(path, V1);
      await p.A.flushPending();
      await B.waitForVersion(path, 1);
      B.stop();
      p.A.fakeVault.write(path, V2);
      await p.A.flushPending();

      let killed = false;
      B = await restartPlugin(B, p.server, {
        prepare: (fresh) => {
          fresh.fakeVault.write(path, edit);
          fresh.fakeVault.mtimes.set(path, Date.now() + 5_000);
          // Kill inside the sibling write (a path the server never committed).
          const writeBinary = fresh.fakeVault.writeBinary.bind(fresh.fakeVault);
          fresh.fakeVault.writeBinary = (
            target: string,
            data: Uint8Array,
            opts?: { mtime?: number },
          ) => {
            if (!isConflictPath(target)) return writeBinary(target, data, opts);
            fresh.fakeVault.files.set(target, new TextEncoder().encode("# Mine"));
            fresh.fakeVault.mtimes.set(target, Date.now());
            killed = true;
            throw new Error("the app was killed inside the sibling write");
          };
        },
      });
      await waitFor(() => killed, "the apply to die inside the sibling write");
      B.stop();

      // Its path has no server head: the record is the only thing that knows it is a
      // fragment of this device's own write.
      const record = persistedRecord(B);
      assertEquals(record.length, 1);
      assert(isConflictPath(record[0].path), `recorded the sibling path: ${record[0].path}`);
      assertEquals(
        B.fakeVault.files.get(path) && text(B.fakeVault.files.get(path)),
        edit,
        "the original path still holds the local edit",
      );

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(1);
      await settle(B);

      // The partial copy is gone, and nothing of it was committed: the conflict path runs
      // again over the real edit.
      assert(
        ![...B.fakeVault.files.values()].some((bytes) => text(bytes) === "# Mine"),
        "the torn sibling was removed, not synced",
      );
      assertEquals(persistedRecord(B), [], "nothing survives the start that read it");
      assertEquals(B.syncManager!.getConflictCount() <= 1, true);
      const siblings = conflictFiles(B);
      for (const sibling of siblings) {
        assertEquals(text(B.fakeVault.files.get(sibling)), edit, "a sibling holds the full edit");
      }
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

Deno.test({
  name: "interrupted-download - a write that fails before writing forces nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "failed-before-write.md";
      const pathHash = hashPathHex(B.keys!.mac_key, path);

      p.A.fakeVault.write(path, V1);
      await p.A.flushPending();
      await B.waitForVersion(path, 1);
      B.stop();
      p.A.fakeVault.write(path, V2);
      await p.A.flushPending();
      await waitFor(
        () => pathVersionCount(p.server, p.vaultId, pathHash) === 2,
        "the peer's second version",
      );

      // The record is written, then the bridge dies before a single byte: the disk still
      // holds v1, which is exactly what the row tracks.
      let failed = false;
      B = await restartPlugin(B, p.server, {
        prepare: failBeforeWrite(path, () => {
          failed = true;
        }),
      });
      await waitFor(() => failed, "the write to fail before it starts");
      B.stop();

      assertEquals(persistedRecord(B).map((entry) => entry.path), [path]);
      assertEquals(text(B.fakeVault.files.get(path)), V1, "nothing was written");
      assertEquals(persistedRow(B, path)?.last_seen_version, 1);

      B = await restartPlugin(B, p.server);
      await B.waitForCaughtUp(2);
      await settle(B);

      assertEquals(persistedRecord(B), [], "the record is cleared");
      assertEquals(text(B.fakeVault.files.get(path)), V2, "the head lands normally");
      assertEquals(conflictFiles(B), [], "nothing was forced into a conflict");
      assertEquals(versionCount(p.server, p.vaultId), 2, "nothing extra is committed");
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

Deno.test({
  name: "interrupted-download - an out-of-scope version records nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const path = "Projects/excluded.md";

      B.pluginSettings.excludedFolders = ["Projects/"];
      B.stop();
      p.A.fakeVault.write(path, BODY);
      await p.A.flushPending();

      B = await restartPlugin(B, p.server, {
        settings: { excludedFolders: ["Projects/"] },
      });
      await B.waitForCaughtUp(1);
      await settle(B);

      assertEquals(text(B.fakeVault.files.get(path)), "<gone>", "an excluded path is not written");
      assertEquals(persistedRecord(B), [], "nothing written, nothing recorded");
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});
