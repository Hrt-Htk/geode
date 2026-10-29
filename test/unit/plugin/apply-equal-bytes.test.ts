import { assertEquals } from "@std/assert";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion } from "../../../core/protocol.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// A resync re-applies every head (`force`). A head whose bytes are already on disk
// must not cost a chunk download or a rewrite; a head whose file is missing must
// still be fetched and written back.

const PATH = "note.md";
const BODY = "# note\nline one\nline two\n";

type Harness = {
  vault: FakeVault;
  state: StateDB;
  keys: VaultKeys;
  writes: string[];
  blobs: string[];
  deps: ApplyDeps;
  msg: (version: number) => Promise<ServerVersion>;
  close: () => void;
};

async function harness(withBlobs: boolean): Promise<Harness> {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
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

  vault.write(PATH, BODY);
  const bytes = vault.files.get(PATH)!;
  const normalized = normalizeForHash(PATH, bytes);
  const plaintextHash = blake3Hex(normalized);
  const pathHash = hashPathHex(keys.mac_key, PATH);

  const blobMap = new Map<string, Uint8Array>();
  const chunkHashes: string[] = [];
  if (withBlobs) {
    for (const part of chunk(normalized)) {
      const hash = blake3Hex(part);
      chunkHashes.push(hash);
      blobMap.set(hash, await encryptChunk(part, keys, hash));
    }
  }
  const blobs: string[] = [];
  const encMetadata = b64encode(
    await encryptMetadata(
      {
        path: PATH,
        mtime: vault.mtimes.get(PATH)!,
        size: bytes.length,
        mime: "text/markdown",
        plaintext_hash: plaintextHash,
      },
      keys,
      pathHash,
    ),
  );

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
    onConflict: () => {},
    markLocalEdit: () => {},
    myDeviceId: "device-a",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
  };

  return {
    vault,
    state,
    keys,
    writes,
    blobs,
    deps,
    msg: (version) =>
      Promise.resolve({
        type: "server_version",
        vault_id: "vault",
        seq: version,
        path_hash: pathHash,
        parent_version: version - 1,
        enc_metadata: encMetadata,
        chunk_hashes: withBlobs ? chunkHashes : ["never-fetched"],
        deleted: false,
        device_id: "peer",
        version,
      }),
    close: () => state.close(),
  };
}

function seedRow(h: Harness, plaintextHash: string): void {
  h.state.upsertLocalFile({
    path: PATH,
    path_hash: hashPathHex(h.keys.mac_key, PATH),
    size: BODY.length,
    mtime: Date.now(),
    plaintext_hash: plaintextHash,
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
}

Deno.test("apply equal bytes: no chunk fetch, no write, the row still advances", async () => {
  const h = await harness(false);
  try {
    vaultSetup(h);
    h.writes.length = 0;

    await applyVersion(await h.msg(2), h.deps);

    assertEquals(h.blobs, [], "the chunks are never fetched");
    assertEquals(h.writes, [], "the file is never rewritten");
    const row = h.state.getLocalFile(PATH)!;
    assertEquals(row.last_seen_version, 2, "the row advances to the applied version");
    assertEquals(row.deleted, false);
    assertEquals(h.state.getSyncCursor(), 2, "the version is accounted for");
  } finally {
    h.close();
  }
});

Deno.test("apply equal bytes: a missing file is still fetched and written back", async () => {
  const h = await harness(true);
  try {
    vaultSetup(h);
    h.vault.files.delete(PATH);
    h.vault.mtimes.delete(PATH);
    h.writes.length = 0;

    await applyVersion(await h.msg(2), h.deps);

    assertEquals(h.blobs.length > 0, true, "the missing file is downloaded");
    assertEquals(h.writes, [PATH], "and written back to disk");
    assertEquals(new TextDecoder().decode(h.vault.files.get(PATH)), BODY);
    assertEquals(h.state.getLocalFile(PATH)!.last_seen_version, 2);
  } finally {
    h.close();
  }
});

/** The row the head is compared against: disk, row and head all agree, and version 1
 * is already accounted for, so the applied version's seq can advance the cursor. */
function vaultSetup(h: Harness): void {
  const bytes = h.vault.files.get(PATH)!;
  seedRow(h, blake3Hex(normalizeForHash(PATH, bytes)));
  h.state.advanceSyncCursor(1);
}
