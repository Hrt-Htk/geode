import { assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

// #609: a name whose plain delete this device has queued is already being deleted by
// its own op: pairing it with a create of identical bytes writes a second marker for a
// rename that never happened and steals the real move's note.

function seed(vault: FakeVault, state: StateDB, path: string, body: string): void {
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: body.length,
    mtime: vault.mtimes.get(path) ?? Date.now(),
    plaintext_hash: blake3Hex(normalizeForHash(path, new TextEncoder().encode(body))),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
}

function removeSilently(vault: FakeVault, path: string): void {
  vault.files.delete(path);
  vault.mtimes.delete(path);
}

/** One reconcile pass (the constructor's own start-up pass), captured from onOps. */
async function reconcile(
  vault: FakeVault,
  state: StateDB,
  hasPendingDelete?: (path: string) => boolean,
): Promise<ReconcileOp[]> {
  const ran = Promise.withResolvers<ReconcileOp[]>();
  const reconciler = new Reconciler(
    vault as never,
    state,
    (ops) => ran.resolve(ops),
    (path) => !path.startsWith("/"),
    false,
    massDeleteGuard((held, total) =>
      ran.reject(new Error(`mass-delete guard tripped: ${held.length} of ${total}`))
    ),
    ".obsidian",
    () => Promise.resolve(null),
    undefined,
    hasPendingDelete,
  );
  reconciler.start();
  try {
    return await ran.promise;
  } finally {
    reconciler.stop();
  }
}

Deno.test("reconciler never pairs a delete the event layer is already deleting", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // `n1.md` was deleted and `dir-b/n1.md` renamed away with identical bytes: one
    // delete and one create, the shape decision 5 pairs. The delete is still queued.
    vault.write("n1.md", "same");
    seed(vault, state, "n1.md", "same");
    removeSilently(vault, "n1.md");
    vault.write("n4.md", "same");

    const ops = await reconcile(vault, state, (path) => path === "n1.md");

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`),
      ["create:n4.md"],
      "the queued delete owns n1.md: no marker is written for it",
    );
    assertEquals(ops[0].renamedFrom, undefined, "the create is not claimed as its destination");
  } finally {
    state.close();
  }
});

Deno.test("reconciler still pairs an identical delete and create with no queued op", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // The control for the test above: the same bytes with nothing queued is the
    // rename-while-closed case decision 5 exists for.
    vault.write("n1.md", "same");
    seed(vault, state, "n1.md", "same");
    removeSilently(vault, "n1.md");
    vault.write("n4.md", "same");

    const ops = await reconcile(vault, state, () => false);

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`),
      ["delete:n1.md", "create:n4.md"],
      "a silent move still pairs into one marker and one note",
    );
    assertEquals(ops[0].renamedTo, "n4.md");
    assertEquals(ops[1].renamedFrom, "n1.md");
  } finally {
    state.close();
  }
});
