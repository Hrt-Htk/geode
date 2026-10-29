import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { assert } from "@std/assert";
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

Deno.test("reconciler picks up .obsidian/ files after setSyncObsidianConfig(true) without reconstruction", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  let capturedOps: ReconcileOp[] = [];
  const onOps = (ops: ReconcileOp[]) => {
    capturedOps = ops;
  };

  vault.write(".obsidian/app.json", '{"theme":"obsidian"}');
  vault.write("notes/test.md", "# Hello");

  // isSyncable=true lets .obsidian/ paths through the filter, but the
  // scanObsidianDir block is still gated on syncObsidianConfig=false.
  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(true),
    false, // syncObsidianConfig = false: .obsidian/ discovery is OFF
    massDeleteGuard(),
  );

  reconciler.start();
  await reconciler.run(true);

  const createdPaths1 = capturedOps.filter((op) => op.kind === "create").map((op) => op.path);
  assert(
    !createdPaths1.includes(".obsidian/app.json"),
    "should NOT discover .obsidian/ when syncObsidianConfig is false",
  );
  assert(createdPaths1.includes("notes/test.md"), "should still discover regular notes");

  // Flip the flag at runtime: no Reconciler reconstruction needed.
  reconciler.setSyncObsidianConfig(true);
  await reconciler.run(true);

  const createdPaths2 = capturedOps.filter((op) => op.kind === "create").map((op) => op.path);
  assert(
    createdPaths2.includes(".obsidian/app.json"),
    "should discover .obsidian/ after setSyncObsidianConfig(true)",
  );
  assert(createdPaths2.includes("notes/test.md"), "should still discover regular notes");

  reconciler.stop();
  state.close();
});
