import { assertEquals } from "@std/assert";
import { ConflictHandler } from "../../../plugin/sync/conflict-handler.ts";
import { deriveKeys, VaultKeys } from "../../../core/crypto.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// Characterization tests for handleConflict's guard early-returns (the branches
// a real end-to-end sync never reaches cleanly). These pin the retry/drop and
// no-op semantics before the #387 split: a missing server head or a locked
// vault must abort without surfacing a conflict file and without clearing the
// per-path merge-retry counter (except on the retry-cap fallback, which clears
// it before fetching).

function noHeadsTransport() {
  let getHeadsCalls = 0;
  return {
    async *getHeads() {
      getHeadsCalls++;
    },
    getBlob: () => new Uint8Array(),
    getHeadsCalls: () => getHeadsCalls,
  };
}

Deno.test("conflict-handler-guards - locked (no state/keys) is a no-op", async () => {
  const transport = noHeadsTransport();
  const localEditPaths = new Set(["a.md"]);
  const handler = new ConflictHandler({
    vault: new FakeVault() as never,
    vaultId: "v",
    transport: transport as never,
    getState: () => null,
    getKeys: () => null,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths,
    files: () => [],
  });

  await handler.handleConflict("a.md", { path_hash: "h", version: 1 });

  assertEquals(handler.getConflictCount(), 0, "no conflict surfaced while locked");
  assertEquals(transport.getHeadsCalls(), 0, "server head not fetched while locked");
  assertEquals(localEditPaths.has("a.md"), true, "localEditPaths untouched while locked");
});

Deno.test("conflict-handler-guards - missing server head aborts before any merge", async () => {
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const vault = new FakeVault();
  vault.write("a.md", "local");
  const transport = noHeadsTransport();
  const localEditPaths = new Set(["a.md"]);
  const handler = new ConflictHandler({
    vault: vault as never,
    vaultId: "v",
    transport: transport as never,
    getState: () => state,
    getKeys: () => keys as VaultKeys,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths,
    files: () => [],
  });

  await handler.handleConflict("a.md", { path_hash: "h", version: 1 });

  assertEquals(transport.getHeadsCalls(), 1, "head fetched once (version cache miss)");
  assertEquals(handler.getConflictCount(), 0, "no conflict surfaced without a head");
  assertEquals(
    localEditPaths.has("a.md"),
    true,
    "localEditPaths survives an aborted merge (pending commit state kept)",
  );
  assertEquals(
    [...vault.files.keys()].some((p) => p.includes("conflict")),
    false,
    "no conflict file written",
  );
  state.close();
});

Deno.test("conflict-handler-guards - retry-cap fallback aborts when the head is missing", async () => {
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const vault = new FakeVault();
  vault.write("a.md", "local");
  const transport = noHeadsTransport();
  const localEditPaths = new Set(["a.md"]);
  const handler = new ConflictHandler({
    vault: vault as never,
    vaultId: "v",
    transport: transport as never,
    getState: () => state,
    getKeys: () => keys as VaultKeys,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths,
    files: () => [],
  });
  // Pre-seed the retry counter at the cap so the next call takes the fallback.
  (handler as unknown as { conflictRetries: Map<string, number> }).conflictRetries.set("a.md", 5);

  await handler.handleConflict("a.md", { path_hash: "h", version: 1 });

  assertEquals(transport.getHeadsCalls(), 1, "fallback fetches the head directly");
  assertEquals(handler.getConflictCount(), 0, "no conflict surfaced without a head");
  assertEquals(
    (handler as unknown as { conflictRetries: Map<string, number> }).conflictRetries.size,
    0,
    "retry-cap fallback clears the counter before fetching",
  );
  assertEquals(
    [...vault.files.keys()].some((p) => p.includes("conflict")),
    false,
    "no conflict file written",
  );
  state.close();
});

Deno.test("conflict-handler-guards - resolutions of one path are serialized", async () => {
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const vault = new FakeVault();
  vault.write("a.md", "local");
  let heads = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const transport = {
    async *getHeads() {
      heads++;
      await gate;
    },
    getBlob: () => new Uint8Array(),
  };
  const handler = new ConflictHandler({
    vault: vault as never,
    vaultId: "v",
    transport: transport as never,
    getState: () => state,
    getKeys: () => keys as VaultKeys,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths: new Set(),
    files: () => [],
  });

  // #589/#590: an apply-triggered resolution and a rejected commit's resolution of the
  // same path race: both read the disk before either writes, so the loser would overwrite
  // the bytes the winner kept. The second waits, then resolves against the head as it
  // stands after the first.
  const first = handler.handleConflict("a.md", { path_hash: "h", version: 1 });
  const second = handler.handleConflict("a.md", { path_hash: "h", version: 2 });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(heads, 1, "the queued resolution has not started while the first runs");
  release();
  await first;
  await second;
  assertEquals(heads, 2, "the queued resolution re-reads the head once the first is done");
  state.close();
});

Deno.test("conflict-handler-guards - a head the row already tracks is stale", async () => {
  const state = openStateDB();
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const vault = new FakeVault();
  vault.write("a.md", "local");
  state.upsertLocalFile({
    path: "a.md",
    path_hash: "h",
    size: 5,
    mtime: 1,
    plaintext_hash: "p",
    last_seen_version: 5,
    chunk_hashes: [],
  });
  const transport = {
    async *getHeads() {
      yield {
        path_hash: "h",
        version: 4,
        seq: 4,
        deleted: false,
        enc_metadata: "",
        chunk_hashes: [],
      };
    },
    getBlob: () => new Uint8Array(),
  };
  const handler = new ConflictHandler({
    vault: vault as never,
    vaultId: "v",
    transport: transport as never,
    getState: () => state,
    getKeys: () => keys as VaultKeys,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths: new Set(["a.md"]),
    files: () => [],
  });

  // The row already applied version 5; a resolution for 4 would write an older server
  // copy over bytes that newer resolution kept. Nothing to do, and nothing to clear.
  await handler.handleConflict("a.md", { path_hash: "h", version: 4 });

  assertEquals(handler.getConflictCount(), 0, "no conflict surfaced for a stale head");
  assertEquals(
    [...vault.files.values()].map((b) => new TextDecoder().decode(b)),
    ["local"],
    "the local bytes are untouched",
  );
  state.close();
});
