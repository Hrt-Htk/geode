import { assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

// #59: a path whose download is in flight (this session's batch, or a record read back from
// a killed one) may hold a fragment. The pass must neither commit it as a create/modify nor
// close it as a delete: the apply that finishes the download owns it.

function seed(state: StateDB, path: string, body: string): void {
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: body.length,
    mtime: 1,
    plaintext_hash: blake3Hex(normalizeForHash(path, new TextEncoder().encode(body))),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
}

/** One reconcile pass (the constructor's own start-up pass), captured from onOps. */
async function reconcile(
  vault: FakeVault,
  state: StateDB,
  inFlight?: (path: string) => boolean,
): Promise<string[]> {
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
    undefined,
    inFlight,
  );
  reconciler.start();
  try {
    const ops = await ran.promise;
    return ops.map((op) => `${op.kind}:${op.path}`).sort();
  } finally {
    reconciler.stop();
  }
}

Deno.test("reconciler leaves a path whose download is in flight alone", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // A fragment with no row (a create the pass would otherwise commit) and a fragment
    // that diverged from its row (a modify the pass would otherwise commit).
    vault.write("fragment-create.md", "# Mee");
    vault.write("fragment-update.md", "# Mee");
    seed(state, "fragment-update.md", "# Meeting notes\n\nall of it\n");
    // A tracked file the pass would close as a delete.
    seed(state, "fragment-delete.md", "# Gone\n");
    // An ordinary edit the pass must still report.
    vault.write("real-edit.md", "# Real\n\nedited\n");
    seed(state, "real-edit.md", "# Real\n");

    const inFlight = (path: string) => path.startsWith("fragment-");
    assertEquals(await reconcile(vault, state, inFlight), ["modify:real-edit.md"]);

    // Control: without the record the pass reports all four, so the gate is what held them.
    assertEquals(await reconcile(vault, state, () => false), [
      "create:fragment-create.md",
      "delete:fragment-delete.md",
      "modify:fragment-update.md",
      "modify:real-edit.md",
    ]);
  } finally {
    state.close();
  }
});
