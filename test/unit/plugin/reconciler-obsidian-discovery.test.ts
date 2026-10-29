import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { assert, assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";

/**
 * isSyncable that mirrors plugin/plumbing/settings-types.ts behavior.
 * When syncObsidianConfig is true, allows .obsidian/ paths except workspace.json/graph.json.
 */
function makeIsSyncable(syncObsidianConfig: boolean): (path: string) => boolean {
  return (path: string) => {
    if (path.startsWith(".obsidian/")) {
      if (!syncObsidianConfig) return false;
      const excluded = ["workspace.json", "graph.json"];
      const fileName = path.split("/").pop();
      if (excluded.includes(fileName ?? "")) return false;
      return true;
    }
    return !path.startsWith("/");
  };
}

Deno.test("reconciler discovers .obsidian/ files when syncObsidianConfig is enabled", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  // Add .obsidian/ files (FakeVault.getAllLoadedFiles() excludes them, mirroring real Obsidian)
  vault.write(".obsidian/app.json", '{"theme":"obsidian"}');
  vault.write(".obsidian/community-plugins.json", '["plugin-a","plugin-b"]');
  vault.write(".obsidian/plugins/some-plugin/data.json", '{"enabled":true}');
  vault.write(".obsidian/workspace.json", '{"active":true}'); // should be excluded by isSyncable
  vault.write("notes/test.md", "# Hello");

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(true),
    true, // syncObsidianConfig = true
    massDeleteGuard(),
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const createdPaths = capturedOps.filter((op) => op.kind === "create").map((op) => op.path);

  assert(createdPaths.includes(".obsidian/app.json"), "should discover .obsidian/app.json");
  assert(
    createdPaths.includes(".obsidian/community-plugins.json"),
    "should discover community-plugins.json",
  );
  assert(
    createdPaths.includes(".obsidian/plugins/some-plugin/data.json"),
    "should discover nested plugin file",
  );

  // workspace.json must be excluded by isSyncable
  assert(!createdPaths.includes(".obsidian/workspace.json"), "should exclude workspace.json");

  // Regular notes still work
  assert(createdPaths.includes("notes/test.md"), "should still discover regular notes");
});

Deno.test("reconciler does NOT discover .obsidian/ files when syncObsidianConfig is disabled", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  vault.write(".obsidian/app.json", '{"theme":"obsidian"}');
  vault.write("notes/test.md", "# Hello");

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(false),
    false, // syncObsidianConfig = false
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const createdPaths = capturedOps.filter((op) => op.kind === "create").map((op) => op.path);

  assert(
    !createdPaths.includes(".obsidian/app.json"),
    "should NOT discover .obsidian/ files when disabled",
  );
  assert(createdPaths.includes("notes/test.md"), "should still discover regular notes");
});

Deno.test("reconciler emits a modify op for a tracked .obsidian/ file whose content changed", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  const configPath = ".obsidian/app.json";
  vault.write(configPath, '{"theme":"obsidian"}');

  // Track the .obsidian file as if it was synced before.
  const stat = vault.mtimes.get(configPath)!;
  const data = vault.files.get(configPath)!;
  state.upsertLocalFile({
    path: configPath,
    path_hash: `${configPath}_hash`,
    size: data.length,
    mtime: stat,
    plaintext_hash: "abc123",
    last_seen_version: 1,
    chunk_hashes: [],
  });

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(true),
    true, // syncObsidianConfig = true
  );
  reconciler.start();

  // First run: tracked + on disk with matching mtime/hash: no op.
  await reconciler.run(true);
  assertEquals(
    capturedOps.filter((o) => o.path === configPath),
    [],
    "unchanged tracked .obsidian file must produce no op",
  );

  // Change the file on disk: must produce a modify op via the .obsidian scan.
  capturedOps = [];
  vault.write(configPath, '{"theme":"obsidian","extra":true}');
  await reconciler.run(true);

  const ops = capturedOps.filter((o) => o.path === configPath);
  assertEquals(ops.length, 1, "changed .obsidian file must produce exactly one op");
  assertEquals(ops[0].kind, "modify", "changed .obsidian file must produce a modify op");

  reconciler.stop();
  state.close();
});

Deno.test("reconciler handles missing .obsidian/ directory gracefully", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  // No .obsidian/ files at all: only a regular note
  vault.write("notes/test.md", "# Hello");

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(true),
    true, // syncObsidianConfig = true, but no .obsidian/ dir exists
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const createdPaths = capturedOps.filter((op) => op.kind === "create").map((op) => op.path);
  assert(
    createdPaths.includes("notes/test.md"),
    "should discover regular notes even without .obsidian/",
  );
});
