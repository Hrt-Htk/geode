import { assert, assertEquals, assertRejects } from "@std/assert";
import { b64encode, ServerVersion, type VersionRecord } from "../../../core/protocol.ts";
import { deriveKeys, encryptChunk, encryptMetadata, VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { type ActivityInput } from "../../../plugin/sync/activity-log.ts";
import { ReplayPipeline } from "../../../plugin/sync/replay.ts";
import { resolveInterruptedWrites } from "../../../plugin/sync/interrupted-writes.ts";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { Transport, TransportState } from "../../../plugin/sync/transport.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import type { InFlightWrite } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { openSessionStateDB } from "../../helpers/state.ts";

// #84: any apply failure must record an Activity error even when the device has
// no local row for that path (a file new to the device), across replay flush,
// live apply, deferred-rename retry, parked re-apply, and interrupted-write
// resolution, without advancing the sync cursor past the failed version.

class FakeTransport extends EventTarget {
  state: TransportState = "syncing";
  lastSeen = 0;
  constructor(state: TransportState) {
    super();
    this.state = state;
  }
  getState(): TransportState {
    return this.state;
  }
  rewindLastSeen(seq: number): void {
    if (seq < this.lastSeen) this.lastSeen = seq;
  }
  getBlob: (hash: string) => Promise<Uint8Array> = () =>
    Promise.reject(new Error("blob GET missing: 404"));
  getVersionChain: (pathHash: string) => Promise<VersionRecord[]> = () => Promise.resolve([]);
  stop(): void {}
}

async function makeVersion(
  path: string,
  content: string,
  seq: number,
  version: number,
  keys: VaultKeys,
): Promise<{ msg: ServerVersion; blob: Uint8Array }> {
  const normalized = new TextEncoder().encode(content);
  const chunkHash = blake3Hex(normalized);
  const blob = await encryptChunk(normalized, keys, chunkHash);
  const pathHash = hashPathHex(keys.mac_key, path);
  const encMeta = await encryptMetadata(
    {
      path,
      mtime: 1,
      size: normalized.length,
      mime: "text/markdown",
      plaintext_hash: blake3Hex(normalized),
    },
    keys,
    pathHash,
  );
  return {
    msg: {
      type: "server_version",
      vault_id: "vault",
      seq,
      path_hash: pathHash,
      parent_version: version - 1,
      enc_metadata: b64encode(encMeta),
      chunk_hashes: [chunkHash],
      deleted: false,
      device_id: "peer",
      version,
    },
    blob,
  };
}

type SyncVault = ConstructorParameters<typeof SyncManager>[1]["vault"];

async function makeKeys(): Promise<VaultKeys> {
  return await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
}

async function makeSyncHarness(state: TransportState) {
  const transport = new FakeTransport(state);
  const vault = new FakeVault();
  const recorded: ActivityInput[] = [];
  const sm = new SyncManager(transport as unknown as Transport, {
    vault: vault as unknown as SyncVault,
    settings: { ...DEFAULT_SETTINGS, deviceId: "me", vaultId: "vault" },
    configDir: ".obsidian",
    recordActivity: (input) => recorded.push(input),
    reconnect: () => Promise.resolve(),
  });
  const db = openSessionStateDB();
  const keys = await makeKeys();
  sm.setState(db, keys);
  return { transport, vault, sm, db, keys, recorded };
}

function makePipeline(
  keys: VaultKeys,
  interrupted?: InFlightWrite[],
) {
  const state = openSessionStateDB(null, null, null, interrupted ?? null);
  const vault = new FakeVault();
  const recorded: ActivityInput[] = [];
  const transport = new FakeTransport("live");
  const pipeline = new ReplayPipeline({
    vault: vault as never,
    transport: transport as unknown as Transport,
    state: () => state,
    keys: () => keys,
    deviceId: "me",
    vaultId: "vault",
    localEditPaths: new Set<string>(),
    hasLocalEdits: () => false,
    markLocalEdit: () => {},
    onConflict: () => {},
    onStatusUpdate: () => {},
    getSelfWriteSuppressor: () => null,
    getSelfRenameSuppressor: () => null,
    recordActivity: (input) => recorded.push(input),
    isSyncable: () => true,
    deviceName: "me",
    isRenameTarget: () => false,
    pendingRenameTarget: () => undefined,
    hasPendingDelete: () => false,
    cancelPendingDelete: () => {},
    isParkedMove: () => false,
    hasUnflushedEdit: () => false,
  });
  return { state, vault, recorded, transport, pipeline };
}

Deno.test("replay-apply-error - flushReplayBuffer records error for new file with no local row and holds cursor", async () => {
  const { transport, sm, db, keys, recorded } = await makeSyncHarness("syncing");
  try {
    const v1 = await makeVersion("notes/new-missing.md", "v1", 1, 1, keys);
    const v2 = await makeVersion("notes/new-missing.md", "v2", 2, 2, keys);
    const ok = await makeVersion("notes/ok.md", "hello", 3, 1, keys);
    transport.getBlob = (hash) => {
      if (hash === ok.msg.chunk_hashes[0]) return Promise.resolve(ok.blob);
      return Promise.reject(new Error(`blob GET ${hash}: 404`));
    };

    await sm.handleVersion(v1.msg);
    await sm.handleVersion(v2.msg);
    await sm.handleVersion(ok.msg);
    transport.state = "live";
    await sm.flushReplayBuffer();

    const err = recorded.find((e) => e.path === "notes/new-missing.md" && e.kind === "error");
    assert(err, "expected Activity error for new file with no local row");
    assert(err.cause?.includes("404"), `expected 404 cause, got ${err.cause}`);
    assert(
      recorded.some((e) => e.path === "notes/ok.md" && e.kind === "download"),
      "subsequent versions still apply",
    );
    assertEquals(
      db.getSyncCursor(),
      0,
      "cursor must stay behind failed winner and its superseded seqs",
    );
  } finally {
    db.close();
  }
});

Deno.test("replay-apply-error - flushReplayBuffer falls back to path_hash when metadata cannot decrypt", async () => {
  const { transport, sm, db, keys, recorded } = await makeSyncHarness("syncing");
  try {
    const pathHash = hashPathHex(keys.mac_key, "notes/corrupt.md");
    const badMsg: ServerVersion = {
      type: "server_version",
      vault_id: "vault",
      seq: 1,
      path_hash: pathHash,
      parent_version: 0,
      enc_metadata: b64encode(new Uint8Array(64)),
      chunk_hashes: [],
      deleted: false,
      device_id: "peer",
      version: 1,
    };

    await sm.handleVersion(badMsg);
    transport.state = "live";
    await sm.flushReplayBuffer();

    const err = recorded.find((e) => e.path === pathHash && e.kind === "error");
    assert(err, "expected Activity error keyed by path_hash when metadata fails to decrypt");
    assert(err.cause && err.cause.length > 0, "expected non-empty error cause");
    assertEquals(db.getSyncCursor(), 0, "cursor must not advance past corrupt version");
  } finally {
    db.close();
  }
});

Deno.test("replay-apply-error - live handleVersion records error for new file and existing file and holds cursor", async () => {
  const { transport, sm, db, keys, recorded } = await makeSyncHarness("live");
  try {
    const newFile = await makeVersion("notes/live-new.md", "live content", 1, 1, keys);
    transport.getBlob = (hash) => Promise.reject(new Error(`blob GET ${hash}: 404`));

    await assertRejects(() => sm.handleVersion(newFile.msg), Error, "404");

    const newErr = recorded.find((e) => e.path === "notes/live-new.md" && e.kind === "error");
    assert(newErr, "expected Activity error on live apply failure for new file");
    assert(newErr.cause?.includes("404"));
    assertEquals(db.getSyncCursor(), 0, "cursor must not advance on live apply failure");

    const existingHash = hashPathHex(keys.mac_key, "notes/live-existing.md");
    db.upsertLocalFile({
      path: "notes/live-existing.md",
      path_hash: existingHash,
      size: 3,
      mtime: 1,
      plaintext_hash: blake3Hex(new TextEncoder().encode("old")),
      last_seen_version: 1,
      chunk_hashes: [],
      deleted: false,
    });
    const updated = await makeVersion("notes/live-existing.md", "new content", 2, 2, keys);
    await assertRejects(() => sm.handleVersion(updated.msg), Error, "404");

    const existingErr = recorded.find(
      (e) => e.path === "notes/live-existing.md" && e.kind === "error",
    );
    assert(existingErr, "expected Activity error on live apply failure for existing row");
    assert(existingErr.cause?.includes("404"));
    assertEquals(db.getSyncCursor(), 0);
  } finally {
    db.close();
  }
});

Deno.test("replay-apply-error - retryDeferred records error for new file when sibling fetch fails", async () => {
  const keys = await makeKeys();
  const { state, recorded, pipeline } = makePipeline(keys);
  try {
    state.advanceSyncCursor(1);
    const v = await makeVersion("notes/deferred.md", "body", 2, 1, keys);
    const deps = pipeline.buildApplyDeps(state, keys);
    deps.parkDeferred!(v.msg, "notes/renamed.md");
    state.holdSyncCursor(2);

    await pipeline.retryDeferred(() => false);

    const err = recorded.find((e) => e.path === "notes/deferred.md" && e.kind === "error");
    assert(err, "expected Activity error when deferred retry fails");
    assert(err.cause?.includes("404"));
    assertEquals(state.getSyncCursor(), 1, "cursor stays behind parked deferred seq");
  } finally {
    state.close();
  }
});

Deno.test("replay-apply-error - reapplyParked records error when parked version fails after resolution", async () => {
  const keys = await makeKeys();
  const path = "notes/parked.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  const { state, recorded, pipeline } = makePipeline(keys, [{
    path,
    path_hash: pathHash,
    expected_plaintext_hash: "deadbeef",
    expected_size: 14,
  }]);
  try {
    const v = await makeVersion(path, "parked content", 1, 1, keys);
    // Live version arrives while interrupted write is unresolved -> gets parked.
    await pipeline.handleVersion(v.msg);
    assertEquals(recorded.length, 0, "parked version did not fail yet");

    // Flush resolves the absent interrupted write -> re-applies parked -> blob 404.
    await pipeline.flushReplayBuffer();
    await pipeline.flushVersionQueue();

    const err = recorded.find((e) => e.path === path && e.kind === "error");
    assert(err, "expected Activity error when re-applying parked version fails");
    assert(err.cause?.includes("404"));
    assertEquals(state.getSyncCursor(), 0);
  } finally {
    state.close();
  }
});

Deno.test("replay-apply-error - resolveInterruptedWrites records error when resolution fails", async () => {
  const keys = await makeKeys();
  const path = "notes/stuck-interrupted.md";
  const pathHash = hashPathHex(keys.mac_key, path);
  const { state, vault, recorded, pipeline } = makePipeline(keys, [{
    path,
    path_hash: pathHash,
    expected_plaintext_hash: "deadbeef",
    expected_size: 100,
  }]);
  vault.files.set(path, new TextEncoder().encode("part"));
  try {
    const resolved = await resolveInterruptedWrites({
      state,
      keys,
      vaultId: "vault",
      apply: pipeline.buildApplyDeps(state, keys),
      chainHead: () => Promise.reject(new Error("head fetch 500")),
    });
    assertEquals(resolved.length, 0);
    const err = recorded.find((e) => e.path === path && e.kind === "error");
    assert(err, "expected Activity error when interrupted write resolution fails");
    assert(err.cause?.includes("head fetch 500"));
  } finally {
    state.close();
  }
});
