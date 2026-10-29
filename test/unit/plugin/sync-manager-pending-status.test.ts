import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("SyncManager.commitQueue - reconciler ops emit pending status before commit and clear after", async () => {
  // SyncManager subscribes to transport events in its constructor.
  const transport = { getState: () => "live", addEventListener: () => {} } as any;
  const vault = new FakeVault();
  const state = openStateDB();

  const settings = { ...DEFAULT_SETTINGS };

  const sm = new SyncManager(transport, {
    vault: vault as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });

  // Inject state but leave keys null so the commit loop body is skipped
  // (no transport/crypto needed).
  (sm as any).state = state;
  (sm as any).keys = null;

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  await (sm as any).commitQueue.enqueue([
    { kind: "commit", path: "a.md" },
    { kind: "commit", path: "b.md" },
  ], "handleReconcilerOps");

  // First call must be the "pending" status with the op count.
  assertEquals(calls[0], ["pending", 2]);

  // Somewhere after the first call there must be a "pending", 0 (clear).
  const pendingZeroIndex = calls.findIndex((c) => c[0] === "pending" && c[1] === 0);
  assert(pendingZeroIndex > 0, "should emit [pending, 0] after processing");

  // A locked pass processes nothing: it is an idle sync cycle (refreshes the
  // last-backup stamp) but not an ack: marked { idle: true } so the session
  // never starts the green hold (#420).
  assertEquals(calls[calls.length - 1], ["sync", { idle: true }]);
  assertEquals(calls.filter((c) => c[0] === "sync").length, 1);

  // pendingOps should now be empty.
  assertEquals(sm.getPendingOps().length, 0);

  state.close();
});

Deno.test("SyncManager.commitQueue - an empty pass (unlocked) emits sync with the idle marker", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS };
  const transport = { getState: () => "live", addEventListener: () => {} } as any;

  const sm = new SyncManager(transport, {
    vault: vault as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  // The reconciler calls onOps([]) every cycle on an idle vault: the pass
  // must still report a clean sync cycle (last-backup stamp): just not an ack.
  await sm.handlePendingOps([]);

  const syncs = calls.filter((c) => c[0] === "sync");
  assertEquals(syncs.length, 1, "an empty pass must emit exactly one sync");
  assertEquals(syncs[0][1], { idle: true }, "the empty pass must carry the idle marker");

  state.close();
});
