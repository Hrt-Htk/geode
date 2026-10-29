import { assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// A local delete inside an excluded folder must NOT propagate (#342): the
// reconciler's delete candidates skip out-of-scope paths.

function seedFile(vault: FakeVault, state: StateDB, path: string) {
  const data = vault.files.get(path);
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: data?.length ?? 0,
    mtime: vault.mtimes.get(path) ?? Date.now(),
    plaintext_hash: "abc123",
    last_seen_version: 1,
    chunk_hashes: [],
  });
}

async function runReconcile(
  vault: FakeVault,
  state: StateDB,
  isSyncable: (p: string) => boolean,
): Promise<ReconcileOp[]> {
  let ops: ReconcileOp[] = [];
  const r = new Reconciler(
    vault as never,
    state,
    (o) => {
      ops = o;
    },
    isSyncable,
    false,
    massDeleteGuard(),
  );
  r.start(); // sets isRunning; run() no-ops without it
  await r.run(true);
  r.stop();
  return ops;
}

Deno.test("reconciler - local delete inside excluded folder does not propagate", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  vault.write("excluded/a.md", "content a");
  seedFile(vault, state, "excluded/a.md");
  vault.delete("excluded/a.md"); // user deleted it locally while excluded

  const ops = await runReconcile(vault, state, (p) => !p.startsWith("excluded/"));
  assertEquals(ops, [], "no delete op for an out-of-scope path");
});

Deno.test("reconciler - local delete in scope still propagates", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  vault.write("notes/a.md", "content a");
  seedFile(vault, state, "notes/a.md");
  vault.delete("notes/a.md");

  const ops = await runReconcile(vault, state, (p) => !p.startsWith("excluded/"));
  assertEquals(ops.map((o) => `${o.kind}:${o.path}`), ["delete:notes/a.md"]);
});

Deno.test("reconciler - edits inside excluded folder are not pushed", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  vault.write("excluded/a.md", "content a");
  seedFile(vault, state, "excluded/a.md");
  vault.write("excluded/a.md", "edited while excluded");

  const ops = await runReconcile(vault, state, (p) => !p.startsWith("excluded/"));
  assertEquals(ops, [], "no modify op for an out-of-scope path");
});
