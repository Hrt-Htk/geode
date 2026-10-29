import { assert, assertEquals } from "@std/assert";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

function deferred(): { p: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

type CommitResult = { kind: "ack"; seq: number; version: number } | {
  kind: "error";
  message: string;
};

function fakeTransport(commitImpl: () => Promise<CommitResult>) {
  let call = 0;
  const liveHandlers: Array<(e: Event) => void> = [];
  const transport = {
    getState: () => "live",
    addEventListener: (name: string, cb: (e: Event) => void) => {
      if (name === "live") liveHandlers.push(cb);
    },
    headBlob: () => Promise.resolve(false),
    putBlob: async () => {},
    commit: () => {
      call++;
      return commitImpl();
    },
    stop: () => {},
    getCalls: () => call,
    fireLive: () => {
      for (const cb of liveHandlers) cb(new Event("live"));
    },
  };
  return transport;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function setup(commitImpl: () => Promise<CommitResult>) {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  const vault = new FakeVault();
  const settings = { ...DEFAULT_SETTINGS };
  const transport = fakeTransport(commitImpl);
  const sm = new SyncManager(transport as never, {
    vault: vault as never,
    settings: settings as never,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  sm.setState(state, keys);
  return { sm, transport, state, vault, keys };
}

Deno.test("sync-manager-commit-batch - ops queued mid-batch survive (no clobber)", async () => {
  const gate = deferred();
  const { sm, transport, state, vault } = await setup(async () => {
    await gate.p;
    return { kind: "ack", seq: 1, version: 1 };
  });
  vault.write("a.md", "a");
  vault.write("b.md", "b");

  // First batch blocks on the gate while committing a.md.
  const p1 = sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  // Wait until a.md's commit is in flight before enqueuing the second batch.
  await sleep(30);
  const p2 = sm.handlePendingOps([{ path: "b.md", kind: "commit" }]);

  gate.resolve();
  await Promise.all([p1, p2]);

  assertEquals(transport.getCalls(), 2, "both batches' ops must be committed");
  assertEquals(sm.getPendingOps().length, 0, "no op left stuck after both batches");

  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - delete supersedes an older queued commit for the same path", async () => {
  const gate = deferred();
  const { sm, state, vault, keys } = await setup(async () => {
    await gate.p;
    return { kind: "ack", seq: 1, version: 1 };
  });
  vault.write("a.md", "a");
  vault.write("b.md", "b");
  // b.md already exists on the server (has a local row), so a delete is meaningful.
  state.upsertLocalFile({
    path: "b.md",
    path_hash: hashPathHex(keys.mac_key, "b.md"),
    size: 1,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 1,
    chunk_hashes: [],
  });

  // Batch 1: commit(a) blocks in flight; commit(b) stays queued behind it.
  const p1 = sm.handlePendingOps([
    { path: "a.md", kind: "commit" },
    { path: "b.md", kind: "commit" },
  ]);
  await sleep(30);
  // A delete for the still-queued b.md must supersede the older pending commit.
  // The file is gone from the vault index by the time the delete drains (the
  // user deleted it): a delete op only ever commits for an absent file.
  await vault.delete("b.md");
  const p2 = sm.handlePendingOps([{ path: "b.md", kind: "delete" }]);

  gate.resolve();
  await Promise.all([p1, p2]);

  assertEquals(state.getLocalFile("b.md")?.deleted, true, "the latest op (delete) must win");
  assertEquals(sm.getPendingOps().length, 0);

  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - exception clears in-progress flag and resets status", async () => {
  const { sm, state, vault } = await setup(() => {
    throw new Error("blob PUT failure");
  });
  vault.write("a.md", "a");

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  await sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);

  // A throwing commitOp must not leave the op stuck in flight: it is requeued for a
  // retry (a transient throw is not a lost edit, #589), and the pass still reports.
  assertEquals(sm.getPendingOps().map((o) => o.path), ["a.md"], "the op is requeued, not stuck");
  assertEquals(sm.getDroppedCount(), 0, "a transient throw is not a dropped edit");
  assertEquals(
    calls[calls.length - 1],
    ["sync", { failed: true }],
    "status reports the failed pass",
  );

  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - in-flight op stays visible in getPendingOps while a later batch arrives", async () => {
  const gate = deferred();
  const { sm, transport, state, vault } = await setup(async () => {
    await gate.p;
    return { kind: "ack", seq: 1, version: 1 };
  });
  vault.write("a.md", "a");
  vault.write("b.md", "b");

  const p1 = sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  await sleep(30); // a.md is now in flight and unsettled
  const p2 = sm.handlePendingOps([{ path: "b.md", kind: "commit" }]);

  // The unsettled (in-flight) op from batch 1 must survive the arrival of
  // batch 2: an overwrite would drop it from getPendingOps.
  assert(
    sm.getPendingOps().some((o) => o.path === "a.md"),
    "in-flight op must remain visible in getPendingOps",
  );

  gate.resolve();
  await Promise.all([p1, p2]);

  assertEquals(transport.getCalls(), 2);
  assertEquals(sm.getPendingOps().length, 0);

  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - a failed op requeued behind a newer op for its path is dropped", async () => {
  const gate = deferred();
  let n = 0;
  const { sm, transport, state, vault, keys } = await setup(async () => {
    if (++n === 1) {
      await gate.p;
      return { kind: "error", message: "timeout" };
    }
    return { kind: "ack", seq: n, version: n };
  });
  vault.write("a.md", "recreated");
  state.upsertLocalFile({
    path: "a.md",
    path_hash: hashPathHex(keys.mac_key, "a.md"),
    size: 1,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 1,
    chunk_hashes: [],
  });

  // delete(a) is in flight when the user recreates a.md.
  const p1 = sm.handlePendingOps([{ path: "a.md", kind: "delete" }]);
  await sleep(30);
  const p2 = sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  gate.resolve(); // the delete fails
  await Promise.all([p1, p2]);

  transport.fireLive();
  await sleep(100);

  assertEquals(
    state.getLocalFile("a.md")?.deleted ?? false,
    false,
    "a stale delete must not win over the recreate",
  );
  assertEquals(sm.getPendingOps().length, 0);

  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - an op enqueued mid-pass resolves only once it is committed", async () => {
  const gate = deferred();
  const { sm, transport, state, vault } = await setup(async () => {
    await gate.p;
    return { kind: "ack", seq: 1, version: 1 };
  });
  vault.write("a.md", "a");
  vault.write("b.md", "b");

  const p1 = sm.handlePendingOps([{ path: "a.md", kind: "commit" }]);
  await sleep(30);
  const p2 = sm.handlePendingOps([{ path: "b.md", kind: "commit" }]);
  gate.resolve();
  await p2;

  assertEquals(transport.getCalls(), 2, "awaiting handlePendingOps must mean its op was committed");
  await p1;
  sm.stop();
  state.close();
});

Deno.test("sync-manager-commit-batch - a delete still commits when the vault index lags a file gone from disk", async () => {
  let commits = 0;
  const { sm, state, vault, keys } = await setup(() => {
    commits++;
    return Promise.resolve({ kind: "ack", seq: 2, version: 2 });
  });
  state.upsertLocalFile({
    path: "gone.md",
    path_hash: hashPathHex(keys.mac_key, "gone.md"),
    size: 1,
    mtime: 1,
    plaintext_hash: "",
    last_seen_version: 1,
    chunk_hashes: [],
  });
  // Mobile index lag (#498 review): the index still lists the path, the disk doesn't.
  vault.getAbstractFileByPath = (path: string) => (path === "gone.md" ? { path } : null);

  await sm.handlePendingOps([{ path: "gone.md", kind: "delete" }]);

  assertEquals(commits, 1, "the delete reaches the server");
  assertEquals(state.getLocalFile("gone.md")?.deleted, true);
  sm.stop();
  state.close();
});
