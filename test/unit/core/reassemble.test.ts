import { IntegrityError, reassemble } from "../../../core/reassemble.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { deriveKeys, encryptChunk } from "../../../core/crypto.ts";
import { assert, assertEquals } from "@std/assert";

const TEST_PASSPHRASE = "test-passphrase-reassemble";
const TEST_SALT = new Uint8Array(16).fill(0x99);

function makeTestKeys() {
  return deriveKeys(TEST_PASSPHRASE, TEST_SALT);
}

async function makeChunks(data: Uint8Array) {
  const keys = await makeTestKeys();
  const plaintextHash = blake3Hex(data);
  const chunkHashes: string[] = [];
  const encryptedChunks = new Map<string, Uint8Array>();

  // Split into 3 chunks of ~100 bytes each for testing
  const chunkSize = Math.ceil(data.length / 3);
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
    const hash = blake3Hex(chunk);
    chunkHashes.push(hash);
    encryptedChunks.set(hash, await encryptChunk(chunk, keys, hash));
  }

  return { chunkHashes, encryptedChunks, plaintextHash, keys };
}

Deno.test({
  name: "reassemble - reassemble of chunks recovers original bytes",
  async fn() {
    const original = new TextEncoder().encode("reassemble test content here");
    const { chunkHashes, encryptedChunks, plaintextHash, keys } = await makeChunks(original);
    const fetchBlob = (hash: string) => Promise.resolve(encryptedChunks.get(hash)!);
    const result = await reassemble(chunkHashes, keys, fetchBlob, plaintextHash);
    assertEquals(result, original);
  },
});

Deno.test({
  name: "reassemble - integrity check throws on chunk reorder",
  async fn() {
    const original = new TextEncoder().encode("reorder test content");
    const { chunkHashes, encryptedChunks, plaintextHash, keys } = await makeChunks(original);

    if (chunkHashes.length < 2) {
      return;
    }

    // Swap first two chunks
    const reordered = [...chunkHashes];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];

    const fetchBlob = (hash: string) => Promise.resolve(encryptedChunks.get(hash)!);
    try {
      await reassemble(reordered, keys, fetchBlob, plaintextHash);
      throw new Error("expected IntegrityError");
    } catch (e) {
      assert(e instanceof IntegrityError, `expected IntegrityError, got ${e}`);
    }
  },
});

Deno.test({
  name: "reassemble - integrity check throws on one chunk swapped",
  async fn() {
    const original = new TextEncoder().encode("swap test content");
    const { chunkHashes, encryptedChunks, plaintextHash, keys } = await makeChunks(original);

    if (chunkHashes.length < 2) {
      return;
    }

    // Use a wrong hash that maps to garbage data
    const badHashes = [...chunkHashes];
    badHashes[0] = "0".repeat(64);

    const fetchBlob = (hash: string) =>
      Promise.resolve(
        hash === "0".repeat(64) ? new Uint8Array(100).fill(0x00) : encryptedChunks.get(hash)!,
      );

    try {
      await reassemble(badHashes, keys, fetchBlob, plaintextHash);
      throw new Error("expected error");
    } catch (e) {
      assert(e instanceof Error, `expected Error, got ${e}`);
    }
  },
});

Deno.test({
  name: "reassemble - fetches chunks in order",
  async fn() {
    const original = new TextEncoder().encode("order test content");
    const { chunkHashes, encryptedChunks, plaintextHash, keys } = await makeChunks(original);

    const fetchOrder: string[] = [];
    const fetchBlob = (hash: string) => {
      fetchOrder.push(hash);
      return Promise.resolve(encryptedChunks.get(hash)!);
    };

    await reassemble(chunkHashes, keys, fetchBlob, plaintextHash);
    assertEquals(fetchOrder, chunkHashes);
  },
});
