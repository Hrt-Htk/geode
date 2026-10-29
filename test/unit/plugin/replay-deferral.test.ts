import { assert, assertEquals } from "@std/assert";
import {
  b64encode,
  RENAME_MARKER,
  type ServerVersion,
  type VersionRecord,
} from "../../../core/protocol.ts";
import { deriveKeys, VaultKeys } from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { ReplayPipeline } from "../../../plugin/sync/replay.ts";
import type { Transport } from "../../../plugin/sync/transport.ts";
import { getRecentLog } from "../../../plugin/plumbing/log.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #583: every version a pending rename defers keeps its own held sync seq. Keying the
// parked set by path hash alone loses the first version's seq until a restart
// re-delivers it, so the cursor stalls behind a version that was already resolved.

type ParkedRow = { version: number; deleted: number; rename_mark?: number };

class MarkerTransport extends EventTarget {
  constructor(private rows: ParkedRow[]) {
    super();
  }
  getVersionChain(_pathHash: string, version?: number): Promise<VersionRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => version === undefined || r.version <= version)
        .map((r) => ({ ...r, device_id: "peer" })) as unknown as VersionRecord[],
    );
  }
}

function version(path: string, keys: VaultKeys, seq: number, version: number): ServerVersion {
  return {
    type: "server_version",
    vault_id: "vault",
    seq,
    path_hash: hashPathHex(keys.mac_key, path),
    parent_version: version - 1,
    enc_metadata: b64encode(new TextEncoder().encode("{}")),
    chunk_hashes: [],
    deleted: false,
    device_id: "peer",
    version,
  };
}

async function makePipeline(rows: ParkedRow[]) {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const state = openStateDB();
  const transport = new MarkerTransport(rows);
  const pipeline = new ReplayPipeline({
    vault: new FakeVault() as never,
    transport: transport as unknown as Transport,
    state: () => state,
    keys: () => keys,
    deviceId: "me",
    localEditPaths: new Set<string>(),
    hasLocalEdits: () => false,
    markLocalEdit: () => {},
    onConflict: () => {},
    onStatusUpdate: () => {},
    getSelfWriteSuppressor: () => null,
    getSelfRenameSuppressor: () => null,
    isSyncable: () => true,
    deviceName: "me",
    isRenameTarget: () => false,
    pendingRenameTarget: () => undefined,
    hasPendingDelete: () => false,
    cancelPendingDelete: () => {},
  });
  return { keys, state, pipeline };
}

Deno.test("replay-deferral - two versions parked behind one rename both release their seq", async () => {
  // The rename's marker (version 3) carried both deferred content versions over.
  const { keys, state, pipeline } = await makePipeline([{
    version: 3,
    deleted: 1,
    rename_mark: RENAME_MARKER,
  }]);
  try {
    state.advanceSyncCursor(1);
    const deps = pipeline.buildApplyDeps(state, keys);
    for (const [seq, ver] of [[2, 2], [3, 3]] as const) {
      const msg = version("a.md", keys, seq, ver);
      deps.parkDeferred!(msg, "b.md");
      state.holdSyncCursor(seq);
    }

    await pipeline.retryDeferred(() => false);

    assertEquals(state.getSyncCursor(), 3, "the cursor advances past every parked seq");
  } finally {
    state.close();
  }
});

Deno.test("replay-deferral - the parked set is capped and a dropped version keeps its seq held", async () => {
  const { keys, state, pipeline } = await makePipeline([{
    version: 999,
    deleted: 1,
    rename_mark: RENAME_MARKER,
  }]);
  try {
    state.advanceSyncCursor(1);
    const deps = pipeline.buildApplyDeps(state, keys);
    const cap = ReplayPipeline.DEFERRED_MAX;
    const since = Date.now();
    for (let i = 0; i < cap + 1; i++) {
      const seq = i + 2;
      deps.parkDeferred!(version("a.md", keys, seq, seq), "b.md");
      state.holdSyncCursor(seq);
    }

    await pipeline.retryDeferred(() => false);

    const dropped = getRecentLog().find((e) =>
      e.ts >= since && e.msg === "deferred version dropped at the cap, its seq stays held"
    );
    assert(dropped, "dropping a parked version is logged, never silent");
    assertEquals(dropped!.fields.seq, 2, "the oldest parked version is the one dropped");
    assertEquals(
      state.getSyncCursor(),
      1,
      "the dropped version's seq stays held so the next reconnect re-delivers its content",
    );

    await pipeline.retryDeferred(() => false);
    assertEquals(
      state.getSyncCursor(),
      1,
      "a second retry cannot advance past the dropped seq either",
    );
  } finally {
    state.close();
  }
});
