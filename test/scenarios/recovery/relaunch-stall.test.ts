import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { pair, restartPlugin, type TestPlugin, waitFor } from "../../two-vault-driver.ts";

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
