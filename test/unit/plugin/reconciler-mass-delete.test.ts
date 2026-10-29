import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import {
  type HeldFile,
  MASS_DELETE_MIN_FILES,
  MASS_DELETE_MIN_PERCENT,
} from "../../../plugin/sync/mass-delete-hold.ts";
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

/**
 * Seed a tracked file in state with the vault's real size/mtime.
 */
function seedFile(vault: FakeVault, state: StateDB, path: string) {
  const stat = vault.mtimes.get(path);
  const data = vault.files.get(path);
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: data?.length ?? 0,
    mtime: stat ?? Date.now(),
    plaintext_hash: "abc123",
    last_seen_version: 0,
    chunk_hashes: [],
  });
}

Deno.test("reconciler enumerates disk via adapter.list, not getAllLoadedFiles (no spurious deletes on incomplete list)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  // Write three files: all on disk.
  vault.write("a.md", "content a");
  vault.write("b.md", "content b");
  vault.write("c.md", "content c");

  // Seed all three as tracked in state.
  seedFile(vault, state, "a.md");
  seedFile(vault, state, "b.md");
  seedFile(vault, state, "c.md");

  // Simulate Android incompleteness: getAllLoadedFiles returns only a.md.
  // adapter.list still sees all three (it enumerates disk, not loaded files).
  vault.getAllLoadedFiles = () => [{ path: "a.md" }];

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(false),
    false,
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const deletePaths = capturedOps.filter((op) => op.kind === "delete").map((op) => op.path);

  // b.md and c.md are on disk: must NOT be deleted.
  assert(!deletePaths.includes("b.md"), "b.md is on disk, must not be deleted");
  assert(!deletePaths.includes("c.md"), "c.md is on disk, must not be deleted");
  assertEquals(deletePaths, [], "no delete ops expected: all tracked files exist on disk");
});

Deno.test("reconciler verifies file existence via adapter.stat before deleting", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  // Write one file.
  vault.write("a.md", "content a");
  seedFile(vault, state, "a.md");

  // Simulate BOTH enumeration paths missing it:
  //   - getAllLoadedFiles returns nothing
  //   - adapter.list returns empty for every directory
  // But "a.md" stays in the vault map so adapter.stat("a.md") SUCCEEDS.
  const originalStat = vault.adapter.stat.bind(vault.adapter);
  vault.getAllLoadedFiles = () => [];
  vault.adapter.list = () => Promise.resolve({ files: [], folders: [] });
  // Ensure stat still works: file is in the vault's internal map.
  vault.adapter.stat = originalStat;

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(false),
    false,
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();

  const deletePaths = capturedOps.filter((op) => op.kind === "delete").map((op) => op.path);

  // stat proves a.md exists: must NOT be deleted.
  assert(!deletePaths.includes("a.md"), "a.md passes stat check, must not be deleted");
  assertEquals(deletePaths, [], "no delete ops expected: stat guard should prevent deletion");
});

type Thresholds = { minFiles: number; minPercent: number };

/** Run one pass over `fileCount` tracked files with `deleteCount` of them removed from
 * disk, and report what the reconciler emitted plus what the guard held. */
async function runGuard(opts: {
  fileCount: number;
  deleteCount: number;
  thresholds?: Thresholds;
  keep?: string;
}): Promise<{
  ops: ReconcileOp[];
  held: HeldFile[] | null;
  totalTracked: number;
  mtimes: Map<string, number>;
}> {
  const vault = new FakeVault();
  const state = openStateDB();
  let ops: ReconcileOp[] = [];
  let held: HeldFile[] | null = null;
  let totalTracked = 0;

  const paths: string[] = [];
  const mtimes = new Map<string, number>();
  for (let i = 0; i < opts.fileCount; i++) {
    const p = `f${i}.md`;
    paths.push(p);
    vault.write(p, `content ${i}`);
    seedFile(vault, state, p);
    mtimes.set(p, vault.mtimes.get(p)!);
  }
  for (const p of paths.slice(0, opts.deleteCount)) await vault.delete(p);
  if (opts.keep) vault.write(opts.keep, "created in the same pass");

  const reconciler = new Reconciler(
    vault as any,
    state,
    (next) => {
      ops = next;
    },
    makeIsSyncable(false),
    false,
    massDeleteGuard(
      (files, total) => {
        held = files;
        totalTracked = total;
      },
      opts.thresholds ?? { minFiles: MASS_DELETE_MIN_FILES, minPercent: MASS_DELETE_MIN_PERCENT },
    ),
  );

  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();
  return { ops, held, totalTracked, mtimes };
}

Deno.test("reconciler holds a delete that meets both defaults and reports the held files", async () => {
  const { ops, held, totalTracked, mtimes } = await runGuard({ fileCount: 20, deleteCount: 20 });

  assertEquals(ops, [], "the whole pass waits: nothing is emitted");
  assert(held !== null, "the guard reported a hold");
  assertEquals(
    held!.map((f) => f.path).sort(),
    [...mtimes.keys()].sort(),
    "every missing path is held",
  );
  assertEquals(totalTracked, 20, "the percent denominator is the tracked count");
  assertEquals(
    held!.find((f) => f.path === "f0.md")!.mtime,
    mtimes.get("f0.md"),
    "last known mtime rides along",
  );
});

Deno.test("reconciler does not hold when the count floor is not met (19 of 20 files)", async () => {
  const { ops, held } = await runGuard({ fileCount: 20, deleteCount: 19 });

  assertEquals(held, null, "95 percent is not enough: the floor is 20 files");
  assertEquals(ops.filter((o) => o.kind === "delete").length, 19, "the deletes go through");
});

Deno.test("reconciler does not hold at exactly the percentage (20 of 80 files)", async () => {
  const { ops, held } = await runGuard({ fileCount: 80, deleteCount: 20 });

  assertEquals(held, null, "exactly 25 percent is not more than 25 percent");
  assertEquals(ops.filter((o) => o.kind === "delete").length, 20, "the deletes go through");
});

Deno.test("reconciler reads custom thresholds", async () => {
  const held4 = await runGuard({
    fileCount: 10,
    deleteCount: 4,
    thresholds: { minFiles: 4, minPercent: 30 },
  });
  assert(held4.held !== null, "4 of 10 files is over a floor of 4 and 30 percent");
  assertEquals(held4.ops, []);

  const underPercent = await runGuard({
    fileCount: 10,
    deleteCount: 4,
    thresholds: { minFiles: 1, minPercent: 50 },
  });
  assertEquals(underPercent.held, null, "4 of 10 is under 50 percent");
  assertEquals(underPercent.ops.filter((o) => o.kind === "delete").length, 4);
});

Deno.test("reconciler allows a normal (below-threshold) deletion through", async () => {
  const { ops, held } = await runGuard({ fileCount: 10, deleteCount: 1 });

  assertEquals(held, null, "1 of 10 is under every threshold");
  assertEquals(ops.filter((o) => o.kind === "delete").map((o) => o.path), ["f0.md"]);
});

Deno.test("reconciler holds the whole pass when the mass-delete guard trips, creates included (#583 decision 10)", async () => {
  const { ops, held } = await runGuard({ fileCount: 20, deleteCount: 20, keep: "imported.md" });

  assert(held !== null, "the guard fired");
  assertEquals(ops, [], "neither deletes nor creates are emitted");
});
