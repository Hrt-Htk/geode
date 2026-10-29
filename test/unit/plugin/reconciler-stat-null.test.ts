import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { assert, assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";

function makeIsSyncable(): (path: string) => boolean {
  return (path: string) => !path.startsWith(".obsidian/") && !path.startsWith("/");
}

function seedFile(vault: FakeVault, state: ReturnType<typeof openStateDB>, path: string) {
  const data = vault.files.get(path);
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: data?.length ?? 0,
    mtime: vault.mtimes.get(path) ?? Date.now(),
    plaintext_hash: "abc123",
    last_seen_version: 0,
    chunk_hashes: [],
  });
}

async function runReconcile(
  vault: FakeVault,
  state: ReturnType<typeof openStateDB>,
): Promise<ReconcileOp[]> {
  let captured: ReconcileOp[] = [];
  const reconciler = new Reconciler(
    vault as any,
    state,
    (ops) => {
      captured = ops;
    },
    makeIsSyncable(),
    false,
    massDeleteGuard(),
  );
  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  return captured;
}

Deno.test("reconciler treats a null adapter.stat as absent (real Obsidian contract, #505)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  vault.write("gone.md", "content");
  seedFile(vault, state, "gone.md");
  // File deleted while Obsidian was closed: enumeration misses it and
  // FakeVault.adapter.stat now resolves null, exactly like real Obsidian.
  vault.delete("gone.md");

  const ops = await runReconcile(vault, state);
  state.close();

  assertEquals(
    ops.filter((op) => op.kind === "delete").map((op) => op.path),
    ["gone.md"],
    "null stat must produce a delete op",
  );
});

Deno.test("reconciler treats a throwing adapter.stat as absent too", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  vault.write("gone.md", "content");
  seedFile(vault, state, "gone.md");
  vault.delete("gone.md");
  vault.adapter.stat = () => {
    throw new Error("ENOENT");
  };

  const ops = await runReconcile(vault, state);
  state.close();

  assert(
    ops.some((op) => op.kind === "delete" && op.path === "gone.md"),
    "throwing stat must produce a delete op",
  );
});
