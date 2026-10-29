import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { assert, assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";

/**
 * isSyncable that mirrors plugin/plumbing/settings-types.ts behavior.
 */
function makeIsSyncable(): (path: string) => boolean {
  return (path: string) => !path.startsWith("/");
}

Deno.test("reconciler.run() does not resolve until onOps promise settles", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  // Create a file that will trigger a "create" op (not tracked in state).
  vault.write("new.md", "hello world");

  // Deferred onOps: we control when it resolves.
  let resolveOnOps: () => void;
  const onOpsPromise = new Promise<void>((resolve) => {
    resolveOnOps = resolve;
  });

  let opsReceived: ReconcileOp[] | null = null;
  const onOps = (ops: ReconcileOp[]) => {
    opsReceived = ops;
    // Don't resolve yet: run() should still be pending.
    return onOpsPromise;
  };

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(),
    false,
    massDeleteGuard(),
  );

  reconciler.start();

  // Track ordering: runResolved should be false until we resolve onOps.
  let runResolved = false;
  let runResolveOrder = 0;

  // Start run() but don't await it yet.
  const runPromise = reconciler.run(true);

  // Mark when run resolves.
  runPromise.then(() => {
    runResolved = true;
    runResolveOrder = 1;
  });

  // Give the microtask queue a tick: reconcile should have completed its
  // disk enumeration and called onOps, but run() should NOT have resolved
  // yet because onOps returned an unresolved promise.
  await new Promise((r) => setTimeout(r, 50));

  // onOps should have been called with the create op.
  assert(opsReceived !== null, "onOps must have been called");
  const received: ReconcileOp[] = opsReceived;
  assertEquals(received.length, 1, "exactly one create op expected");
  assertEquals(received[0].kind, "create");
  assertEquals(received[0].path, "new.md");

  // run() must NOT have resolved yet because onOps hasn't resolved.
  assert(!runResolved, "run() must NOT resolve before onOps resolves");

  // Now resolve the onOps promise.
  resolveOnOps!();

  // Give it a tick to propagate.
  await new Promise((r) => setTimeout(r, 50));

  // Now run() must have resolved.
  assert(runResolved, "run() must resolve after onOps resolves");
  assertEquals(runResolveOrder, 1, "run() resolved after onOps");

  reconciler.stop();
  state.close();
});

Deno.test("reconciler.run() resolves immediately when onOps returns void (no ops)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  // No files on disk, no files tracked: no ops.
  let opsCalled = false;
  const onOps = (ops: ReconcileOp[]) => {
    opsCalled = true;
    assertEquals(ops.length, 0, "no ops expected");
  };

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(),
    false,
  );

  reconciler.start();

  // run() should resolve quickly with no ops.
  await reconciler.run(true);

  // onOps is called with empty array (because ops.length === 0, the
  // `if (ops.length > 0)` block is skipped, but onOps is still called).
  // Actually, looking at the code: `this.onOps(ops)` is called regardless
  // of whether ops is empty. So opsCalled should be true.
  assert(opsCalled, "onOps must be called even with empty ops");

  reconciler.stop();
  state.close();
});

Deno.test("reconciler.run() awaits async onOps even with empty ops array", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  // Deferred: control when onOps resolves.
  let resolveOnOps: () => void;
  const onOpsPromise = new Promise<void>((resolve) => {
    resolveOnOps = resolve;
  });

  let opsCalled = false;
  const onOps = (_ops: ReconcileOp[]) => {
    opsCalled = true;
    return onOpsPromise;
  };

  const reconciler = new Reconciler(
    vault as any,
    state,
    onOps,
    makeIsSyncable(),
    false,
  );

  reconciler.start();

  let runResolved = false;
  const runPromise = reconciler.run(true);
  runPromise.then(() => {
    runResolved = true;
  });

  // Give it a tick: reconcile runs, calls onOps (even with empty ops),
  // but run() should not resolve until onOps resolves.
  await new Promise((r) => setTimeout(r, 50));

  assert(opsCalled, "onOps must have been called");
  assert(!runResolved, "run() must NOT resolve before onOps resolves, even with empty ops");

  resolveOnOps!();
  await new Promise((r) => setTimeout(r, 50));

  assert(runResolved, "run() must resolve after onOps resolves");

  reconciler.stop();
  state.close();
});
