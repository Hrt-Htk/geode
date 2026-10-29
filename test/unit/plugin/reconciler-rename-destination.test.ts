// #697: a row with no version of its own is a rename's destination waiting for its note,
// not a pending local edit, while the bytes on disk are still the ones the row was made
// from. Reading it as an edit made every reconcile pass between the rename and the note
// push a spurious commit at the new name.
import { assertEquals } from "@std/assert";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { massDeleteGuard } from "../../helpers/bytes.ts";

const BASE = "# head\n\nbody\n";

function hashOf(path: string, body: string): string {
  return blake3Hex(normalizeForHash(path, new TextEncoder().encode(body)));
}

/** One reconcile pass (the constructor's own start-up pass), captured from onOps. */
async function reconcile(vault: FakeVault, state: StateDB): Promise<ReconcileOp[]> {
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
  );
  reconciler.start();
  try {
    return await ran.promise;
  } finally {
    reconciler.stop();
  }
}

/** A row a rename created at its destination: no version of this path yet, the base hash
 * the bytes were taken from. */
function recordRenameDestination(
  vault: FakeVault,
  state: StateDB,
  path: string,
  base: string,
): void {
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: base.length,
    mtime: vault.mtimes.get(path) ?? Date.now(),
    plaintext_hash: hashOf(path, base),
    last_seen_version: 0,
    chunk_hashes: [],
    deleted: false,
  });
}

Deno.test("reconciler leaves a rename destination waiting for its note alone", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    vault.write("y.md", BASE);
    recordRenameDestination(vault, state, "y.md", BASE);

    assertEquals(await reconcile(vault, state), [], "nothing to commit at a renamed name");
  } finally {
    state.close();
  }
});

Deno.test("reconciler still commits a carried edit the row has no version for", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    vault.write("y.md", `${BASE}edited after the rename\n`);
    recordRenameDestination(vault, state, "y.md", BASE);

    assertEquals(
      (await reconcile(vault, state)).map((op) => `${op.kind}:${op.path}`),
      ["modify:y.md"],
      "the edit differs from the hash the row carries, so it is owed",
    );
  } finally {
    state.close();
  }
});
