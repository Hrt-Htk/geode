import { assertEquals } from "@std/assert";
import { b64encode, ServerVersion } from "../../../core/protocol.ts";
import { deriveKeys, encryptChunk, encryptMetadata, VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { Transport, TransportState } from "../../../plugin/sync/transport.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

// Characterization tests for the inbound replay/apply pipeline (handleVersion,
// versionQueue serialization, flushReplayBuffer, replayBuffer, versionCache) as
// exercised through SyncManager's public surface. Written green against the
// pre-split sync-manager.ts; must stay green after the pipeline moves to
// replay.ts with semantics unchanged.

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
  getBlob: (hash: string) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array());
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

async function makeSyncManager(state: TransportState) {
  const transport = new FakeTransport(state);
  const vault = new FakeVault();
  const sm = new SyncManager(transport as unknown as Transport, {
    vault: vault as unknown as SyncVault,
    settings: { ...DEFAULT_SETTINGS, deviceId: "me" },
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  const db = openStateDB();
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  sm.setState(db, keys);
  const status: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d?: unknown) => status.push([s, d]));
  return { transport, vault, sm, db, keys, status };
}

/**
 * Live mode: every received version applies immediately, chained on the
 * versionQueue, and each apply emits "sync". The cursor must land at the top of
 * the contiguous run.
 */
Deno.test({
  name: "sync-manager-replay - live handleVersion applies versions in seq order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { transport, vault, sm, db, keys, status } = await makeSyncManager("live");
    const v1 = await makeVersion("a.md", "content a", 1, 1, keys);
    const v2 = await makeVersion("b.md", "content b", 2, 1, keys);
    const blobs = new Map([[v1.msg.chunk_hashes[0], v1.blob], [v2.msg.chunk_hashes[0], v2.blob]]);
    transport.getBlob = (h) => Promise.resolve(blobs.get(h)!);

    await sm.handleVersion(v1.msg);
    await sm.handleVersion(v2.msg);

    assertEquals(new TextDecoder().decode(await vault.readBinary("a.md")), "content a");
    assertEquals(new TextDecoder().decode(await vault.readBinary("b.md")), "content b");
    assertEquals(db.getSyncCursor(), 2, "live applies must advance the cursor");
    assertEquals(status.filter(([s]) => s === "sync").length, 2, "each live apply emits sync");
    // #523: live applies are marked so the session treats them as inbound
    // (never a commit ack, never a drain-complete that clears progress).
    assertEquals(
      status.filter(([s, d]) => s === "sync" && (d as { apply?: boolean })?.apply === true).length,
      2,
    );
    db.close();
  },
});

/**
 * Concurrent live handleVersions must serialize on the versionQueue: firing
 * them without awaiting each still lands every version, in order, with a
 * correct contiguous cursor.
 */
Deno.test({
  name: "sync-manager-replay - concurrent live handleVersions serialize",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { transport, vault, sm, db, keys } = await makeSyncManager("live");
    const vs = await Promise.all([
      makeVersion("a.md", "content a", 1, 1, keys),
      makeVersion("b.md", "content b", 2, 1, keys),
      makeVersion("c.md", "content c", 3, 1, keys),
    ]);
    const blobs = new Map(vs.map((v) => [v.msg.chunk_hashes[0], v.blob]));
    transport.getBlob = (h) => Promise.resolve(blobs.get(h)!);

    await Promise.all(vs.map((v) => sm.handleVersion(v.msg)));

    assertEquals(new TextDecoder().decode(await vault.readBinary("c.md")), "content c");
    assertEquals(db.getSyncCursor(), 3);
    db.close();
  },
});

/**
 * Buffered replay: versions received while "syncing" are buffered, not applied.
 * A coalesced flush applies only the last version per path, emits applying
 * progress, and advances the cursor past ALL superseded seqs only after the
 * winner is durably applied (#212 ordering, #319 progress).
 */
Deno.test({
  name: "sync-manager-replay - buffered replay coalesces on flush and advances cursor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { transport, vault, sm, db, keys, status } = await makeSyncManager("syncing");
    const v1 = await makeVersion("a.md", "v1", 1, 1, keys);
    const v2 = await makeVersion("a.md", "v2", 2, 2, keys);
    const v3 = await makeVersion("a.md", "v3", 3, 3, keys);
    const blobs = new Map([[v3.msg.chunk_hashes[0], v3.blob]]);
    transport.getBlob = (h) => Promise.resolve(blobs.get(h)!);

    await sm.handleVersion(v1.msg);
    await sm.handleVersion(v2.msg);
    await sm.handleVersion(v3.msg);
    assertEquals(db.getSyncCursor(), 0, "buffered versions must not apply yet");

    transport.state = "live";
    await sm.flushReplayBuffer();

    // Only the last version survives on disk.
    assertEquals(new TextDecoder().decode(await vault.readBinary("a.md")), "v3");
    // Cursor advanced through the whole buffered window.
    assertEquals(db.getSyncCursor(), 3);
    // Progress surfaced then cleared.
    assertEquals(
      status.find(([s]) => s === "applying"),
      ["applying", { current: 1, total: 1 }],
    );
    // #523: the drain marks its own completion: the session clears the
    // applying progress only here, never on a commit pass ending mid-drain.
    assertEquals(status[status.length - 1], ["sync", { drain: true }], "flush marks drain done");
    db.close();
  },
});
