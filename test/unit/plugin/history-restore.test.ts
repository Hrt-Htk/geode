import { assertEquals, assertRejects } from "@std/assert";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { b64encode } from "../../../core/protocol.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";
import { RestoreBusy, restoreVersion } from "../../../plugin/sync/history-restore.ts";
import type { Transport } from "../../../plugin/sync/transport.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #465: the restore's success criterion is the ROW holding the restored content,
// not commitOp's boolean: commitOp answers `true` for a same-path commit already in
// flight (silently dropped), so a dropped commit must never read as "restored".

const PATH = "notes/restored.md";

async function fixtures() {
  const keys: VaultKeys = await deriveKeys("unit", new Uint8Array(16), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const body = new TextEncoder().encode("# Restored\n\nold content\n");
  const plaintextHash = blake3Hex(normalizeForHash(PATH, body));
  const chunkHash = blake3Hex(body);
  const blob = await encryptChunk(body, keys, chunkHash);
  const pathHash = hashPathHex(keys.mac_key, PATH);
  const record = {
    path_hash: pathHash,
    version: 1,
    seq: 1,
    parent: null,
    enc_metadata: b64encode(
      await encryptMetadata(
        {
          path: PATH,
          mtime: 1,
          size: body.length,
          mime: "text/markdown",
          plaintext_hash: plaintextHash,
        },
        keys,
        pathHash,
      ),
    ),
    chunk_hashes: [chunkHash],
    deleted: 0,
    device_id: "device-a",
    created_at: 1,
    compacted_range: null,
    rename_mark: 0,
  };
  const vault = new FakeVault();
  vault.write(PATH, "# Current\n\nnew content\n");
  const blobs = new Map([[chunkHash, blob]]);
  return { keys, record, vault, plaintextHash, blobs };
}

/** The slice commitFileBytes + the in-flight wait touch. */
function fakeState(
  row: { plaintext_hash: string; last_seen_version: number } | null,
  onUpsert: (row: { path: string; plaintext_hash: string }) => void,
): StateDB {
  return {
    getLocalFile: () => row,
    upsertLocalFile: onUpsert,
  } as unknown as StateDB;
}

function fakeTransport(blobs: Map<string, Uint8Array>): Transport {
  return {
    getBlob: (hash: string) => Promise.resolve(blobs.get(hash)!),
    headBlob: () => Promise.resolve(true),
    putBlob: () => Promise.resolve(),
    getVersionChain: () => Promise.resolve([]),
    commit: () => Promise.resolve({ kind: "ack", version: 2, seq: 2 }),
  } as unknown as Transport;
}

Deno.test("history-restore - a commit the row never records is not a restore", async () => {
  const { keys, record, vault, blobs } = await fixtures();
  // The ack updates no row: the same shape a deduped commitOp leaves behind.
  const state = fakeState({ plaintext_hash: "stale", last_seen_version: 1 }, () => {});

  await assertRejects(
    () =>
      restoreVersion(record, PATH, {
        vault: vault as never,
        state,
        keys,
        transport: fakeTransport(blobs),
        onConflict: () => {},
      }),
    RestoreBusy,
  );
  assertEquals(
    new TextDecoder().decode(vault.files.get(PATH)),
    "# Restored\n\nold content\n",
    "the bytes are on disk, but nothing reports them as a version",
  );
});

Deno.test("history-restore - a commit the row records is a restore", async () => {
  const { keys, record, vault, plaintextHash, blobs } = await fixtures();
  const row = { plaintext_hash: "stale", last_seen_version: 1 };
  const state = fakeState(row, (next) => {
    row.plaintext_hash = next.plaintext_hash;
  });
  let activity: string | null = null;

  const outcome = await restoreVersion(record, PATH, {
    vault: vault as never,
    state,
    keys,
    transport: fakeTransport(blobs),
    onConflict: () => {},
    recordActivity: (input) => {
      activity = input.kind;
    },
  });

  assertEquals(outcome, "restored");
  assertEquals(row.plaintext_hash, plaintextHash);
  assertEquals(activity, "restore");
});
