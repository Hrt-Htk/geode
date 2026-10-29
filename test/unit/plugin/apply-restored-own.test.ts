import { assertEquals } from "@std/assert";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion } from "../../../core/protocol.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #687: a restore is credited to the device that asked for it, so that device
// receives a version it authored itself. The own-version rule skips those (the file
// is already local); a restored one must be applied like any remote version, and a
// replay of it after a reconnect must not write twice or conflict.

const PATH = "x.md";
const BODY = "# x\nrestored from trash\n";
const MY_DEVICE = "device-a";

type Harness = {
  vault: FakeVault;
  state: StateDB;
  writes: string[];
  blobs: string[];
  conflicts: string[];
  deps: ApplyDeps;
  msg: (version: number, opts: { restored?: boolean; deviceId?: string }) => Promise<ServerVersion>;
  activity: Array<{ kind: string }>;
  close: () => void;
};

async function harness(): Promise<Harness> {
  const keys: VaultKeys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const vault = new FakeVault();
  const state = openStateDB();
  const writes: string[] = [];
  const writeBinary = vault.writeBinary.bind(vault);
  vault.writeBinary = (path: string, data: Uint8Array, opts?: { mtime?: number }) => {
    writes.push(path);
    writeBinary(path, data, opts);
  };

  const bytes = new TextEncoder().encode(BODY);
  const normalized = normalizeForHash(PATH, bytes);
  const plaintextHash = blake3Hex(normalized);
  const pathHash = hashPathHex(keys.mac_key, PATH);

  const blobMap = new Map<string, Uint8Array>();
  const chunkHashes: string[] = [];
  for (const part of chunk(normalized)) {
    const hash = blake3Hex(part);
    chunkHashes.push(hash);
    blobMap.set(hash, await encryptChunk(part, keys, hash));
  }
  const blobs: string[] = [];
  const encMetadata = b64encode(
    await encryptMetadata(
      {
        path: PATH,
        mtime: 1,
        size: bytes.length,
        mime: "text/markdown",
        plaintext_hash: plaintextHash,
      },
      keys,
      pathHash,
    ),
  );
  const conflicts: string[] = [];
  const activity: Array<{ kind: string }> = [];

  const deps: ApplyDeps = {
    vault: vault as never,
    state,
    keys,
    getBlob: (hash) => {
      blobs.push(hash);
      const enc = blobMap.get(hash);
      if (!enc) throw new Error(`unexpected blob fetch: ${hash}`);
      return Promise.resolve(enc);
    },
    hasLocalEdits: () => false,
    onConflict: (path) => {
      conflicts.push(path);
    },
    markLocalEdit: () => {},
    myDeviceId: MY_DEVICE,
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
    recordActivity: (record) => {
      activity.push({ kind: record.kind });
    },
  };

  return {
    vault,
    state,
    writes,
    blobs,
    conflicts,
    activity,
    deps,
    msg: (version, opts) =>
      Promise.resolve({
        type: "server_version",
        vault_id: "vault",
        seq: version,
        path_hash: pathHash,
        parent_version: version - 1,
        enc_metadata: encMetadata,
        chunk_hashes: chunkHashes,
        deleted: false,
        device_id: opts.deviceId ?? MY_DEVICE,
        version,
        restored: opts.restored,
      }),
    close: () => state.close(),
  };
}

/** The state a device is left with after it deleted the file: the row is closed and
 * the bytes are off disk. `restored` is then version 2 on top of the tombstone. */
function afterOwnDelete(h: Harness): void {
  const pathHash = hashPathHex(h.deps.keys.mac_key, PATH);
  h.state.upsertLocalFile({
    path: PATH,
    path_hash: pathHash,
    size: BODY.length,
    mtime: 1,
    plaintext_hash: blake3Hex(normalizeForHash(PATH, new TextEncoder().encode(BODY))),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: true,
  });
  h.state.advanceSyncCursor(1);
}

Deno.test("apply own version: an unmarked own version is never written to disk", async () => {
  const h = await harness();
  try {
    h.state.advanceSyncCursor(1);
    await applyVersion(await h.msg(2, {}), h.deps);

    assertEquals(h.writes, [], "the file is not written");
    assertEquals(h.blobs, [], "no chunks are fetched");
    assertEquals(h.conflicts, [], "no conflict");
    assertEquals(h.state.getLocalFile(PATH)!.last_seen_version, 2, "state records the version");
    assertEquals(h.state.getSyncCursor(), 2);
  } finally {
    h.close();
  }
});

Deno.test("apply own version: a restored own version is applied to disk", async () => {
  const h = await harness();
  try {
    afterOwnDelete(h);
    await applyVersion(await h.msg(2, { restored: true }), h.deps);

    assertEquals(h.writes, [PATH], "the restored file is written back");
    assertEquals(new TextDecoder().decode(h.vault.files.get(PATH)), BODY);
    assertEquals(h.conflicts, [], "a restore is not a conflict");
    const row = h.state.getLocalFile(PATH)!;
    assertEquals(row.deleted, false, "the row is live again");
    assertEquals(row.last_seen_version, 2);
    assertEquals(h.state.getSyncCursor(), 2);
    // #687: the restoring device's own Activity view must not read
    // "Downloaded · <own name>": it restored, it did not download.
    assertEquals(h.activity, [{ kind: "restore" }]);
  } finally {
    h.close();
  }
});

Deno.test("apply own version: a replayed restored version writes once and stays clean", async () => {
  const h = await harness();
  try {
    afterOwnDelete(h);
    const restored = await h.msg(2, { restored: true });
    await applyVersion(restored, h.deps);
    // Reconnect: the server replays the same version, restore mark and all.
    await applyVersion(restored, h.deps);

    assertEquals(h.writes, [PATH], "the file is written once");
    assertEquals(h.conflicts, [], "the replay does not conflict");
    assertEquals(h.state.getLocalFile(PATH)!.last_seen_version, 2);
    assertEquals(h.state.getSyncCursor(), 2);
  } finally {
    h.close();
  }
});

Deno.test("apply version: a peer's restored version is a download", async () => {
  const h = await harness();
  try {
    afterOwnDelete(h);
    await applyVersion(await h.msg(2, { restored: true, deviceId: "device-b" }), h.deps);

    assertEquals(h.writes, [PATH], "the peer's restore is applied");
    assertEquals(h.activity, [{ kind: "download" }], "a peer's restore is a download here");
  } finally {
    h.close();
  }
});
