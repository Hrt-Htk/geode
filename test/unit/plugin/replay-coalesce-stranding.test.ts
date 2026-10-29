import { assertEquals } from "@std/assert";
import { ServerVersion } from "../../../core/protocol.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { Transport, TransportState } from "../../../plugin/sync/transport.ts";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

function v(seq: number, pathHash: string, version: number): ServerVersion {
  return {
    type: "server_version",
    vault_id: "vault",
    seq,
    path_hash: pathHash,
    parent_version: version - 1,
    enc_metadata: "",
    chunk_hashes: [],
    deleted: false,
    device_id: "other",
    version,
  };
}

class FakeTransport extends EventTarget {
  state: TransportState = "syncing";
  lastSeen = 0;
  getState(): TransportState {
    return this.state;
  }
  getLastSeenSeq(): number {
    return this.lastSeen;
  }
  rewindLastSeen(seq: number): void {
    if (seq < this.lastSeen) this.lastSeen = seq;
  }
  getBlob: (hash: string) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array());
  stop(): void {}
}

async function makeSyncManager() {
  const t = new FakeTransport();
  const sm = new SyncManager(
    t as unknown as Transport,
    {
      vault: {
        getAllLoadedFiles: () => [],
        adapter: {
          readBinary: () => Promise.resolve(new Uint8Array()),
          stat: () => Promise.resolve({ size: 0, mtime: 0 }),
          writeBinary: async () => {},
          write: async () => {},
          remove: async () => {},
          exists: () => Promise.resolve(true),
        },
      },
      settings: { ...DEFAULT_SETTINGS, deviceId: "me" },
      configDir: ".obsidian",
      reconnect: () => Promise.resolve(),
    },
  );
  const state = openStateDB();
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  sm.setState(state, keys);
  return { t, sm, state };
}

/**
 * While buffering during a replay, the transport's in-memory lastSeenSeq runs
 * ahead of the (un-flushed) persisted cursor. If the WS drops mid-replay,
 * leaving syncing for a non-live state: a reconnect would re-hello from the
 * bumped lastSeenSeq and the server would NOT re-replay the buffered window,
 * stranding those files (#117/#212). The SyncManager must clear the buffer and
 * rewind the in-memory cursor to the persisted one so the tail is re-requested.
 */
Deno.test({
  name: "replay-coalescing - disconnect mid-replay rewinds cursor and clears the buffer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { t, sm, state } = await makeSyncManager();
    // In-memory cursor is ahead of the empty persisted cursor (received-but-buffered).
    t.lastSeen = 10;

    await sm.handleVersion(v(5, "p", 5));
    await sm.handleVersion(v(6, "p", 6));
    await sm.handleVersion(v(7, "p", 7));
    assertEquals(state.getSyncCursor(), 0); // buffered, nothing applied yet

    // WS drops mid-replay: transport leaves syncing without going live.
    t.state = "disconnected";
    t.dispatchEvent(new CustomEvent("status", { detail: "disconnected" }));

    // In-memory cursor rewound to the persisted cursor, so a reconnect would
    // re-replay exactly the un-applied tail.
    assertEquals(t.getLastSeenSeq(), 0);

    // The buffer was cleared: a subsequent flush (or live) applies nothing.
    await sm.flushReplayBuffer();
    assertEquals(state.getSyncCursor(), 0);
    t.state = "live";
    t.dispatchEvent(new CustomEvent("live", {}));
    assertEquals(state.getSyncCursor(), 0);
  },
});

/**
 * A disconnect while the buffer is EMPTY (a normal live session) must not rewind
 * the cursor: otherwise a transient drop would force a redundant full replay.
 */
Deno.test({
  name: "replay-coalescing - disconnect with empty buffer does not rewind",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { t, sm, state } = await makeSyncManager();
    state.updateSyncCursor(5);
    t.lastSeen = 5;

    t.state = "disconnected";
    t.dispatchEvent(new CustomEvent("status", { detail: "disconnected" }));

    assertEquals(t.getLastSeenSeq(), 5);
    await sm.flushReplayBuffer();
    assertEquals(state.getSyncCursor(), 5);
  },
});
