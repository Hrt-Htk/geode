import {
  authHashHex,
  decryptChunk,
  decryptMetadata,
  decryptPath,
  deriveAuthKey,
  deriveKeys,
  encryptChunk,
  encryptMetadata,
  encryptPath,
} from "../../../core/crypto.ts";
import type { FileMeta } from "../../../core/protocol.ts";
import type { VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";

const TEST_PASSPHRASE = "test-passphrase-gate-2";
const TEST_SALT = new Uint8Array(16).fill(0x42);

Deno.test({
  name: "crypto - deriveKeys is deterministic across calls",
  async fn() {
    const keys1 = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const keys2 = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    assertEquals(keys1.content_key, keys2.content_key);
    assertEquals(keys1.mac_key, keys2.mac_key);
    assertEquals(keys1.nonce_key, keys2.nonce_key);
  },
});

Deno.test({
  name: "crypto - deriveKeys with different salt produces different keys",
  async fn() {
    const salt1 = new Uint8Array(16).fill(0x42);
    const salt2 = new Uint8Array(16).fill(0x99);
    const keys1 = await deriveKeys(TEST_PASSPHRASE, salt1);
    const keys2 = await deriveKeys(TEST_PASSPHRASE, salt2);
    assertThrows(() => {
      assertEquals(keys1.content_key, keys2.content_key);
    });
    assertThrows(() => {
      assertEquals(keys1.mac_key, keys2.mac_key);
    });
  },
});

Deno.test({
  name: "crypto - deriveAuthKey is deterministic and 32 bytes",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const a1 = deriveAuthKey(keys);
    const a2 = deriveAuthKey(keys);
    assertEquals(a1.length, 32);
    assertEquals(a1, a2);
  },
});

Deno.test({
  name: "crypto - deriveAuthKey depends only on content_key, not mac/nonce keys",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const tampered: VaultKeys = {
      content_key: keys.content_key,
      mac_key: new Uint8Array(32).fill(7),
      nonce_key: new Uint8Array(32).fill(9),
    };
    assertEquals(deriveAuthKey(tampered), deriveAuthKey(keys));
  },
});

Deno.test({
  name: "crypto - deriveAuthKey differs for a different content_key",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const other: VaultKeys = {
      content_key: new Uint8Array(32).fill(1),
      mac_key: keys.mac_key,
      nonce_key: keys.nonce_key,
    };
    assertThrows(() => assertEquals(deriveAuthKey(other), deriveAuthKey(keys)));
  },
});

Deno.test({
  name: "crypto - authHashHex is a 64-char hex blake3 of the auth key",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const h = authHashHex(deriveAuthKey(keys));
    assertEquals(h, blake3Hex(deriveAuthKey(keys)));
    assertEquals(/^[0-9a-f]{64}$/.test(h), true);
  },
});

Deno.test({
  name: "crypto - encryptChunk → decryptChunk roundtrip",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const plaintext = new TextEncoder().encode("roundtrip test content");
    const hash = blake3Hex(plaintext);
    const encrypted = await encryptChunk(plaintext, keys, hash);
    const decrypted = await decryptChunk(encrypted, keys, hash);
    assertEquals(decrypted, plaintext);
  },
});

Deno.test({
  name: "crypto - encryptChunk produces byte-identical output for same input (deterministic nonce)",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const plaintext = new TextEncoder().encode("deterministic nonce test");
    const hash = blake3Hex(plaintext);
    const encrypted1 = await encryptChunk(plaintext, keys, hash);
    const encrypted2 = await encryptChunk(plaintext, keys, hash);
    assertEquals(encrypted1, encrypted2);
  },
});

Deno.test({
  name: "crypto - decryptChunk with wrong key throws",
  async fn() {
    const keys1 = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const keys2 = await deriveKeys("different-passphrase", TEST_SALT);
    const plaintext = new TextEncoder().encode("wrong key test");
    const hash = blake3Hex(plaintext);
    const encrypted = await encryptChunk(plaintext, keys1, hash);
    await assertRejects(() => decryptChunk(encrypted, keys2, hash), Error);
  },
});

Deno.test({
  name: "crypto - decryptChunk with corrupted ciphertext throws",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const plaintext = new TextEncoder().encode("corruption test");
    const hash = blake3Hex(plaintext);
    const encrypted = await encryptChunk(plaintext, keys, hash);
    encrypted[30] = (encrypted[30]! + 1) % 256;
    await assertRejects(() => decryptChunk(encrypted, keys, hash), Error);
  },
});

Deno.test({
  name: "crypto - encryptMetadata bound to pathHash",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const meta: FileMeta = {
      path: "test.md",
      mtime: Date.now(),
      size: 100,
      mime: "text/markdown",
      plaintext_hash: "0".repeat(64),
    };
    const pathHash = "abc123".repeat(10);
    const encrypted = await encryptMetadata(meta, keys, pathHash);
    const decrypted = await decryptMetadata(encrypted, keys, pathHash);
    assertEquals(decrypted.path, meta.path);
    await assertRejects(() => decryptMetadata(encrypted, keys, "wrong".repeat(13)), Error);
  },
});

const PATH_HASH = "abc123".repeat(10);

Deno.test({
  name: "crypto - encryptPath → decryptPath roundtrip",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const path = "notes/sub/dir/file.md";
    const encrypted = await encryptPath(path, keys, PATH_HASH);
    const decrypted = await decryptPath(encrypted, keys, PATH_HASH);
    assertEquals(decrypted, path);
  },
});

Deno.test({
  name: "crypto - encryptPath byte-identical for same path + hash (deterministic nonce)",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const path = "deterministic/path.md";
    const e1 = await encryptPath(path, keys, PATH_HASH);
    const e2 = await encryptPath(path, keys, PATH_HASH);
    assertEquals(e1, e2);
  },
});

Deno.test({
  name: "crypto - decryptPath bound to pathHash (wrong pathHash throws)",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const encrypted = await encryptPath("bound.md", keys, PATH_HASH);
    await assertRejects(() => decryptPath(encrypted, keys, "wrong".repeat(13)), Error);
  },
});

Deno.test({
  name: "crypto - decryptPath with wrong key throws",
  async fn() {
    const keys1 = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const keys2 = await deriveKeys("different-passphrase", TEST_SALT);
    const encrypted = await encryptPath("wrong-key.md", keys1, PATH_HASH);
    await assertRejects(() => decryptPath(encrypted, keys2, PATH_HASH), Error);
  },
});

Deno.test({
  name: "crypto - decryptPath with corrupted ciphertext throws",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    const encrypted = await encryptPath("corrupt.md", keys, PATH_HASH);
    encrypted[30] = (encrypted[30]! + 1) % 256;
    await assertRejects(() => decryptPath(encrypted, keys, PATH_HASH), Error);
  },
});

Deno.test({
  name: "crypto - HKDF labels produce 3 distinct keys",
  async fn() {
    const keys = await deriveKeys(TEST_PASSPHRASE, TEST_SALT);
    assertThrows(() => assertEquals(keys.content_key, keys.mac_key));
    assertThrows(() => assertEquals(keys.mac_key, keys.nonce_key));
    assertThrows(() => assertEquals(keys.content_key, keys.nonce_key));
  },
});
