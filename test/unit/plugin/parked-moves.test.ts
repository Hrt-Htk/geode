import { assertEquals } from "@std/assert";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";
import { ParkedMoves } from "../../../plugin/sync/parked-moves.ts";
import type { PendingOp } from "../../../plugin/sync/commit-queue.ts";

const PARKED = {
  oldPath: "notes/x.md",
  destFolder: "Archive-old/",
  destPath: "Archive-old/x.md",
};

/** One parked move whose destination folder is excluded, plus a live row for its name. */
function harness(existsOnDisk: boolean) {
  const state = openStateDB();
  state.upsertLocalFile({
    path: PARKED.oldPath,
    path_hash: "h",
    size: 1,
    mtime: 1,
    plaintext_hash: "p",
    last_seen_version: 3,
    chunk_hashes: [],
    deleted: true,
  });
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    excludedFolders: [PARKED.destFolder],
    pendingMoveOuts: [PARKED],
  };
  const ops: PendingOp[] = [];
  const moves = new ParkedMoves({
    vault: {
      adapter: { stat: () => Promise.resolve(existsOnDisk ? { size: 1, mtime: 1 } : null) },
    },
    settings,
    getState: () => state,
    persist: () => {},
    enqueue: (batch) => {
      ops.push(...batch);
    },
  });
  return { state, settings, ops, moves };
}

Deno.test("parked moves - an exact file entry never completes an unrelated park", async () => {
  const { state, settings, ops, moves } = harness(true);

  // #601: a per-file restore passes the file names it restored. "Archive" is a string
  // prefix of the parked destination folder and must not count as a re-include.
  await moves.release(["Archive"]);

  assertEquals(settings.pendingMoveOuts.length, 1, "the park stays parked");
  assertEquals(state.getLocalFile(PARKED.oldPath)!.deleted, true, "its row stays closed");
  assertEquals(ops, [], "nothing was linked");
  state.close();
});

Deno.test("parked moves - the destination folder coming back in scope resolves the park", async () => {
  const { state, settings, ops, moves } = harness(true);

  await moves.release([PARKED.destFolder]);

  assertEquals(settings.pendingMoveOuts, [], "the park is settled");
  assertEquals(
    ops.map((op) => `${op.kind}:${op.path}`),
    [`delete:${PARKED.oldPath}`, `commit:${PARKED.destPath}`],
    "the marker + note pair an in-scope rename writes",
  );
  assertEquals(state.getLocalFile(PARKED.oldPath)!.deleted, false, "the name is released");
  state.close();
});
