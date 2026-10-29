import { assert, assertEquals } from "@std/assert";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

type CommitResult = { kind: "ack"; seq: number; version: number } | {
  kind: "error";
  message: string;
};

function fakeTransport(results: CommitResult[], opts: { putBlob?: () => Promise<void> } = {}) {
  let call = 0;
  const liveHandlers: Array<(e: Event) => void> = [];
  const transport = {
    getState: () => "live",
    addEventListener: (name: string, cb: (e: Event) => void) => {
      if (name === "live") liveHandlers.push(cb);
    },
    headBlob: () => false,
    putBlob: opts.putBlob ?? (async () => {}),
    commit: () => {
      call++;
      return results[Math.min(call - 1, results.length - 1)];
    },
    stop: () => {},
    getCalls: () => call,
    results,
    fireLive: () => {
      for (const cb of liveHandlers) cb(new Event("live"));
    },
  };
  return transport;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.test("commit-error-requeue - error result is requeued and retried after reconnect", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([
    { kind: "error", message: "commit timeout" },
    { kind: "ack", seq: 2, version: 2 },
  ]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  // First attempt: commit resolves error → op must stay queued (not dropped).
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  assertEquals(transport.getCalls(), 1);
  assert(
    sm.getPendingOps().some((o) => o.path === "a.md"),
    "error result must be requeued into pendingOps",
  );

  // Reconnect: transport goes live again → requeued op is drained and retried.
  transport.fireLive();
  await sleep(100);

  assertEquals(transport.getCalls(), 2, "op must be retried once transport is live");
  assertEquals(sm.getPendingOps().length, 0, "successful retry clears the queue");

  sm.stop();
  state.close();
});

Deno.test("commit-error-requeue - permanently failing commit is dropped after retry cap", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  // First attempt errors and requeues the op.
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  assert(
    sm.getPendingOps().some((o) => o.path === "a.md"),
    "error must requeue initially",
  );

  // Each reconnect drains and retries. After MAX_RETRIES (5) requeues the op
  // must be dropped rather than requeued forever.
  for (let i = 0; i < 5; i++) {
    transport.fireLive();
    await sleep(40);
  }

  assertEquals(transport.getCalls(), 6, "MAX_RETRIES+1 attempts before the drop");
  assertEquals(sm.getPendingOps().length, 0, "op must be dropped after the cap");
  assertEquals(
    (sm as any).hasLocalEdits("a.md"),
    false,
    "dropped op must no longer count as a local edit",
  );

  sm.stop();
  state.close();
});

Deno.test("commit-dropped - op dropped after retry cap is tracked and reported", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  const statuses: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s, d) => statuses.push([s, d]));
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  for (let i = 0; i < 5; i++) {
    transport.fireLive();
    await sleep(40);
  }

  assertEquals(sm.getDroppedCount(), 1, "dropped op must be tracked by path");
  assert(
    statuses.some(([s, d]) => s === "dropped" && d === 1),
    "drop must emit a 'dropped' status with the count",
  );

  sm.stop();
  state.close();
});

Deno.test("commit-dropped - a fresh op for the path clears the dropped mark", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  for (let i = 0; i < 5; i++) {
    transport.fireLive();
    await sleep(40);
  }
  assertEquals(sm.getDroppedCount(), 1);

  transport.results.push({ kind: "ack", seq: 2, version: 2 });
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  assertEquals(sm.getDroppedCount(), 0, "fresh op for the path must clear the dropped mark");
  assertEquals(sm.getPendingOps().length, 0, "retried op must commit and clear the queue");

  sm.stop();
  state.close();
});

Deno.test("commit-dropped - clearPending (resync) clears the dropped marks", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  const statuses: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s, d) => statuses.push([s, d]));
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  for (let i = 0; i < 5; i++) {
    transport.fireLive();
    await sleep(40);
  }
  assertEquals(sm.getDroppedCount(), 1);

  sm.clearPending();
  assertEquals(sm.getDroppedCount(), 0, "clearPending must clear dropped marks");
  assert(
    statuses.some(([s, d]) => s === "dropped" && d === 0),
    "clearPending must emit the cleared 'dropped' count",
  );

  sm.stop();
  state.close();
});

Deno.test("commit-dropped - clearPending clears the retry counts", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  const statuses: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s, d) => statuses.push([s, d]));
  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  assertEquals((sm as any).commitQueue.getMaxRetries(), 1, "a requeued op carries a retry count");

  sm.clearPending();
  assertEquals(
    (sm as any).commitQueue.getMaxRetries(),
    0,
    "clearPending must clear the retry counts (a fresh op must not inherit the orange)",
  );
  assert(
    statuses.some(([s, d]) => s === "retries" && d === 0),
    "clearPending must emit the cleared 'retries' count",
  );

  sm.stop();
  state.close();
});

Deno.test("commit-dropped - retryDropped re-enqueues with a fresh retry budget", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  const transport = fakeTransport([{ kind: "error", message: "invalid_commit" }]);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  for (let i = 0; i < 5; i++) {
    transport.fireLive();
    await sleep(40);
  }
  assertEquals(sm.getDroppedCount(), 1);
  assertEquals(transport.getCalls(), 6);

  transport.results.push({ kind: "ack", seq: 2, version: 2 });
  await sm.retryDropped();
  assertEquals(transport.getCalls(), 7, "retryDropped must re-attempt the dropped op");
  assertEquals(sm.getDroppedCount(), 0, "successful retry must clear the dropped mark");
  assertEquals(sm.getPendingOps().length, 0);

  sm.stop();
  state.close();
});

Deno.test("commit-error-requeue - a transport throw retries instead of counting the op dropped", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  vault.write("a.md", "hello");
  const settings = { ...DEFAULT_SETTINGS };

  // A blob upload over a dying socket throws: transient, so the op must be retried,
  // counting it as dropped would report a lost edit and block the backup stamp (#589).
  let failures = 1;
  const transport = fakeTransport([{ kind: "ack", seq: 2, version: 2 }], {
    putBlob: () =>
      failures-- > 0 ? Promise.reject(new Error("network unreachable")) : Promise.resolve(),
  });
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);

  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  assertEquals(sm.getDroppedCount(), 0, "a transient throw is not a dropped edit");
  assert(sm.getPendingOps().some((o) => o.path === "a.md"), "the op stays queued");

  transport.fireLive();
  await sleep(100);
  assertEquals(transport.getCalls(), 1, "the retry reaches the server");
  assertEquals(sm.getPendingOps().length, 0, "successful retry clears the queue");
  assertEquals(sm.getDroppedCount(), 0);

  sm.stop();
  state.close();
});
