import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { pair, restartPlugin, type TestPlugin, waitFor } from "../../two-vault-driver.ts";
import { setTransportHttp } from "../../../plugin/sync/http-client.ts";
import { toArrayBuffer } from "../../../plugin/plumbing/bytes.ts";

// #59: the phone stalled on relaunch (43 of 90 rows, until the spec's 7-minute timeout), and
// only with the fix: the start pass rewrites the file the killed process left mid-write, and
// that write is where a native bridge can wedge (the handle the dead process held). The pass
// must never hold the session behind it: it is bounded, the entry stays recorded and gated,
// and the drain of everything else must complete.
//
// Kill shape reproduced here: 43 rows persisted (the 2 s row throttle lags), the cursor
// already past the applied versions, a record for the file that was being written, and its
// disk bytes torn. The interrupted file's write then never settles, as on the device.

const N = 90;
const path = (i: number) => `file/${i.toString().padStart(4, "0")}.md`;
const body = (i: number) => `# note ${i}\nline one\nline two\n`;
const TORN_INDEX = 44;

const identity = (p: string, content: string) =>
  blake3Hex(normalizeForHash(p, new TextEncoder().encode(content)));

/** The kill: rows for the first 43 files, cursor at 45, a record for #44, its bytes torn. */
function killState(plugin: TestPlugin): { rows: string; cursor: string } {
  const tornPath = path(TORN_INDEX);
  return {
    rows: JSON.stringify([...plugin.state!.getAllLocalFiles().values()].slice(0, 43)),
    cursor: JSON.stringify({
      vault_id: "default",
      last_seen_seq: 45,
      last_backup_at: 0,
      in_flight_apply: [{
        path: tornPath,
        path_hash: hashPathHex(plugin.keys!.mac_key, tornPath),
        expected_plaintext_hash: identity(tornPath, body(TORN_INDEX)),
      }],
    }),
  };
}

Deno.test({
  name: "relaunch-stall - a wedged write of the interrupted file cannot hold the drain",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      for (let i = 0; i < N; i++) p.A.fakeVault.write(path(i), body(i));
      await p.A.flushPending();
      for (let i = 0; i < N; i++) await B.waitForVersion(path(i));
      await waitFor(() => B.state!.getAllLocalFiles().size === N, "all rows", 30_000);

      // The kill: rows persisted up to 43, #44 torn, cursor at 45 (cursor writes are
      // immediate; rows lag on the throttle), the rest gone from disk.
      const tornPath = path(TORN_INDEX);
      const state = killState(B);
      const rowsFile = B.pluginDataPath("local-files.json");
      const cursorFile = B.pluginDataPath("sync-cursor.json");
      B.fakeVault.files.set(tornPath, new TextEncoder().encode(body(TORN_INDEX).slice(0, 6)));
      for (let i = TORN_INDEX + 1; i < N; i++) {
        B.fakeVault.files.delete(path(i));
        B.fakeVault.mtimes.delete(path(i));
      }
      B.stop();

      let wedged = false;
      const started = Date.now();
      B = await restartPlugin(B, p.server, {
        prepare: (fresh) => {
          fresh.fakeVault.pluginData.set(rowsFile, new TextEncoder().encode(state.rows));
          fresh.fakeVault.pluginData.set(cursorFile, new TextEncoder().encode(state.cursor));
          // The native write never answers for the file the killed process was writing.
          const modifyBinary = fresh.fakeVault.modifyBinary.bind(fresh.fakeVault);
          fresh.fakeVault.modifyBinary = (
            file: { path: string },
            data: ArrayBuffer,
            opts?: { mtime?: number },
          ) => {
            if (file.path !== tornPath) return modifyBinary(file, data, opts);
            wedged = true;
            return new Promise<void>(() => {});
          };
        },
      });
      await waitFor(() => wedged, "the pass to reach the interrupted file", 20_000);

      // Everything the pass is not stuck on lands, and the session reaches the server head.
      const expected = N - 1;
      await waitFor(
        () => B.state!.getAllLocalFiles().size >= expected,
        "the drain to finish the other files",
        30_000,
      );
      await waitFor(
        () => B.state!.getSyncCursor() >= 90,
        "the cursor to reach the head",
        15_000,
      );
      assertEquals(
        B.fakeVault.files.get(tornPath)?.length,
        6,
        "the wedged file keeps its bytes",
      );
      assertEquals(
        B.state!.getInterruptedWrites().map((entry) => entry.path),
        [tornPath],
        "the unresolved entry stays recorded for the next connection",
      );
      console.log("settled in", Date.now() - started, "ms");
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

// The common kill shape has the cursor BEHIND the interrupted version (the cursor advances
// only after an apply lands), so the drain replays that version. If the pass is still working
// on the path (or was abandoned by its bound), the drain must not apply over bytes nobody has
// judged yet: an edit made outside Obsidian between the kill and the relaunch would be lost.
Deno.test({
  name: "relaunch-stall - a version for an unresolved entry is parked, so an outside edit survives",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      const tornPath = path(TORN_INDEX);
      const outsideEdit = "# an editor outside obsidian wrote this\n";
      // Written in order, so the interrupted file's version is the last one on the server:
      // its seq is exactly where the cursor has fallen behind.
      for (let i = 0; i < TORN_INDEX; i++) p.A.fakeVault.write(path(i), body(i));
      await p.A.flushPending();
      p.A.fakeVault.write(tornPath, body(TORN_INDEX));
      await p.A.flushPending();
      for (let i = 0; i <= TORN_INDEX; i++) await B.waitForVersion(path(i));
      await waitFor(() => B.state!.getAllLocalFiles().size === TORN_INDEX + 1, "rows", 30_000);

      // Kill shape: rows persisted for the first 43, the cursor at 44 (BEHIND the version of
      // the file being written), and that file now holds somebody else's bytes.
      const head = B.state!.getLocalFile(path(TORN_INDEX))!;
      const rowsFile = B.pluginDataPath("local-files.json");
      const cursorFile = B.pluginDataPath("sync-cursor.json");
      const rows = JSON.stringify(
        [...B.state!.getAllLocalFiles().values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, TORN_INDEX - 1),
      );
      // The cursor is one ahead of the rows: the row throttle lags, the cursor does not, so
      // the interrupted file's own version is the one the next start replays.
      const cursor = JSON.stringify({
        vault_id: "default",
        last_seen_seq: TORN_INDEX,
        last_backup_at: 0,
        in_flight_apply: [{
          path: tornPath,
          path_hash: head.path_hash,
          expected_plaintext_hash: identity(tornPath, body(TORN_INDEX)),
          expected_size: body(TORN_INDEX).length,
        }],
      });
      B.fakeVault.files.set(tornPath, new TextEncoder().encode(outsideEdit));
      B.stop();

      // The head fetch hangs: the pass is abandoned by its bound while the drain replays the
      // version for that path.
      B = await restartPlugin(B, p.server, {
        prepare: (fresh) => {
          fresh.fakeVault.pluginData.set(rowsFile, new TextEncoder().encode(rows));
          fresh.fakeVault.pluginData.set(cursorFile, new TextEncoder().encode(cursor));
          // The head fetch never answers (a dead socket), while everything else goes out.
          setTransportHttp(async ({ url, method, headers, body }) => {
            if (url.includes("/versions/")) return new Promise(() => {});
            const res = await fetch(url, {
              method,
              headers,
              body: body ? toArrayBuffer(body) : undefined,
            });
            return {
              status: res.status,
              ok: res.ok,
              text: () => res.text(),
              arrayBuffer: () => res.arrayBuffer(),
            };
          });
        },
      });

      console.log(
        "after restart: cursor",
        B.state!.getSyncCursor(),
        "rows",
        B.state!.getAllLocalFiles().size,
        "record",
        JSON.stringify(B.state!.getInterruptedWrites().map((e) => e.path)),
      );
      await waitFor(
        () => (B.transport?.getState() ?? "") === "live",
        "the session to go live",
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 12_000)); // past the pass's bound

      assertEquals(
        new TextDecoder().decode(B.fakeVault.files.get(tornPath)),
        outsideEdit,
        "the outside edit is still there",
      );
      assertEquals(
        B.state!.getInterruptedWrites().some((entry) => entry.path === tornPath),
        true,
        "the entry stays recorded (and gated) for the next connection",
      );
      console.log(
        "final: cursor",
        B.state!.getSyncCursor(),
        "rows",
        B.state!.getAllLocalFiles().size,
        "record",
        JSON.stringify(B.state!.getInterruptedWrites().map((e) => e.path)),
        "disk",
        JSON.stringify(new TextDecoder().decode(B.fakeVault.files.get(tornPath))),
      );
      assertEquals(
        B.state!.getSyncCursor() < TORN_INDEX + 1,
        true,
        `the parked version keeps the cursor behind it (cursor ${B.state!.getSyncCursor()})`,
      );
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});

// The pass is bounded, not absent: when an abandoned pass finishes in the same session it
// resolves the record and the version that was parked for that path must still land, and the
// persisted cursor must advance. Otherwise the file stays parked until a reconnect (days).
Deno.test({
  name: "relaunch-stall - a parked version is re-applied when the pass resolves in-session",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B = p.B;
    try {
      for (let i = 0; i < TORN_INDEX; i++) p.A.fakeVault.write(path(i), body(i));
      await p.A.flushPending();
      p.A.fakeVault.write(path(TORN_INDEX), body(TORN_INDEX));
      await p.A.flushPending();
      for (let i = 0; i <= TORN_INDEX; i++) await B.waitForVersion(path(i));
      await waitFor(() => B.state!.getAllLocalFiles().size === TORN_INDEX + 1, "rows", 30_000);

      const tornPath = path(TORN_INDEX);
      const head = B.state!.getLocalFile(tornPath)!;
      const rowsFile = B.pluginDataPath("local-files.json");
      const cursorFile = B.pluginDataPath("sync-cursor.json");
      const rows = JSON.stringify(
        [...B.state!.getAllLocalFiles().values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, TORN_INDEX - 1),
      );
      const cursor = JSON.stringify({
        vault_id: "default",
        last_seen_seq: TORN_INDEX,
        last_backup_at: 0,
        in_flight_apply: [{
          path: tornPath,
          path_hash: head.path_hash,
          expected_plaintext_hash: identity(tornPath, body(TORN_INDEX)),
          expected_size: body(TORN_INDEX).length,
        }],
      });
      // The write had completed and its commit never ran: the pass clears the record without
      // writing anything, so only a re-apply of the parked version can move the cursor.
      B.fakeVault.files.set(tornPath, new TextEncoder().encode(body(TORN_INDEX)));
      B.stop();

      // The pass's own read of the recorded file is slow: past the pass's bound, so the drain
      // parks the version first and the abandoned pass resolves the record afterwards.
      let firstRead = true;
      B = await restartPlugin(B, p.server, {
        prepare: (fresh) => {
          fresh.fakeVault.pluginData.set(rowsFile, new TextEncoder().encode(rows));
          fresh.fakeVault.pluginData.set(cursorFile, new TextEncoder().encode(cursor));
          const readBinary = fresh.fakeVault.readBinary.bind(fresh.fakeVault);
          fresh.fakeVault.readBinary = async (target: string) => {
            if (target === tornPath && firstRead) {
              firstRead = false;
              await new Promise((resolve) => setTimeout(resolve, 12_000));
            }
            return await readBinary(target);
          };
        },
      });

      // No reconnect: the parked version must land and the cursor must reach the head.
      await waitFor(
        () => B.state!.getSyncCursor() >= TORN_INDEX + 1,
        "the parked version to be re-applied",
        30_000,
      );
      assertEquals(B.state!.getInterruptedWrites(), [], "the record is cleared");
      assertEquals(
        B.state!.getLocalFile(tornPath)?.last_seen_version,
        1,
        "the parked version was applied to the row",
      );
    } finally {
      try {
        B.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});
