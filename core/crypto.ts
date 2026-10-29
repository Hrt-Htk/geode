import { blake3Hex, blake3Keyed } from "./hash.ts";
import type { FileMeta } from "./protocol.ts";

// libsodium-wrappers-sumo via Deno's npm bridge: the useful surface is on `.default`,
// not the namespace export. Cache the unwrapped lib after first init.
type Sodium = {
  ready: Promise<void>;
  crypto_pwhash: (
    keyLen: number,
    passphrase: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    alg: number,
  ) => Uint8Array;
  crypto_pwhash_OPSLIMIT_MODERATE: number;
  crypto_pwhash_MEMLIMIT_MODERATE: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_aead_xchacha20poly1305_ietf_encrypt: (
    m: Uint8Array,
    aad: Uint8Array | null,
    secretNonce: Uint8Array | null,
    nonce: Uint8Array,
    k: Uint8Array,
  ) => Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt: (
    secretNonce: Uint8Array | null,
    ct: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    k: Uint8Array,
  ) => Uint8Array;
  randombytes_buf: (len: number) => Uint8Array;
};

let _sodium: Sodium | null = null;

async function getSodium(): Promise<Sodium> {
  if (_sodium) return _sodium;
  const mod = await import("libsodium-wrappers-sumo");
  const lib = ((mod as unknown as { default?: Sodium }).default ?? mod) as Sodium;
  await lib.ready;
  _sodium = lib;
  return lib;
}

export type VaultKeys = {
  content_key: Uint8Array;
  mac_key: Uint8Array;
  nonce_key: Uint8Array;
};

export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  params?: { opsLimit?: number; memLimit?: number },
): Promise<VaultKeys> {
  const sodium = await getSodium();
  const opsLimit = params?.opsLimit ?? sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memLimit = params?.memLimit ?? sodium.crypto_pwhash_MEMLIMIT_MODERATE;

  const masterKey = sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    opsLimit,
    memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  return {
    content_key: hkdfLabel(masterKey, salt, "geode/content/v1"),
    mac_key: hkdfLabel(masterKey, salt, "geode/mac/v1"),
    nonce_key: hkdfLabel(masterKey, salt, "geode/nonce/v1"),
  };
}

// HKDF-SHA256 via @noble/hashes: sodium has crypto_kdf_derive_from_key but that takes
// a numeric subkey_id + 8-byte context, not our string labels. The doc spec uses HKDF.
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

function hkdfLabel(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, salt, new TextEncoder().encode(info), 32);
}

// Re-key session auth secret (#556): derived from the content key, so every
// unlocked device already has it. The server stores only authHashHex of it.
const AUTH_KEY_SALT = new Uint8Array(32);

export function deriveAuthKey(keys: VaultKeys): Uint8Array {
  return hkdf(
    sha256,
    keys.content_key,
    AUTH_KEY_SALT,
    new TextEncoder().encode("geode/auth/v1"),
    32,
  );
}

export function authHashHex(authKey: Uint8Array): string {
  return blake3Hex(authKey);
}

export async function encryptChunk(
  plaintext: Uint8Array,
  keys: VaultKeys,
  plaintextHashHex: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = blake3Keyed(keys.nonce_key, hexToBytes(plaintextHashHex)).slice(0, 24);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    null,
    null,
    nonce,
    keys.content_key,
  );
  return seal(nonce, ct);
}

export async function decryptChunk(
  ciphertext: Uint8Array,
  keys: VaultKeys,
  plaintextHashHex: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const { nonce: storedNonce, ct } = open(ciphertext);
  const expectedNonce = blake3Keyed(keys.nonce_key, hexToBytes(plaintextHashHex)).slice(0, 24);
  for (let i = 0; i < 24; i++) {
    if (storedNonce[i] !== expectedNonce[i]) {
      throw new Error("nonce mismatch: wrong plaintext hash");
    }
  }
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    null,
    storedNonce,
    keys.content_key,
  );
}

export async function encryptPath(
  path: string,
  keys: VaultKeys,
  pathHashHex: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = blake3Keyed(keys.nonce_key, hexToBytes(pathHashHex)).slice(0, 24);
  const ad = new TextEncoder().encode(pathHashHex);
  const pathBytes = new TextEncoder().encode(path);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pathBytes,
    ad,
    null,
    nonce,
    keys.content_key,
  );
  return seal(nonce, ct);
}

export async function decryptPath(
  ciphertext: Uint8Array,
  keys: VaultKeys,
  pathHashHex: string,
): Promise<string> {
  const sodium = await getSodium();
  const { nonce: storedNonce, ct } = open(ciphertext);
  const expectedNonce = blake3Keyed(keys.nonce_key, hexToBytes(pathHashHex)).slice(0, 24);
  for (let i = 0; i < 24; i++) {
    if (storedNonce[i] !== expectedNonce[i]) {
      throw new Error("nonce mismatch: wrong path hash");
    }
  }
  const ad = new TextEncoder().encode(pathHashHex);
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    ad,
    storedNonce,
    keys.content_key,
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptMetadata(
  meta: FileMeta,
  keys: VaultKeys,
  pathHashHex: string,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(24);
  const ad = new TextEncoder().encode(pathHashHex);
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    metaBytes,
    ad,
    null,
    nonce,
    keys.content_key,
  );
  return seal(nonce, ct);
}

export async function decryptMetadata(
  ct: Uint8Array,
  keys: VaultKeys,
  pathHashHex: string,
): Promise<FileMeta> {
  const sodium = await getSodium();
  const { nonce, ct: body } = open(ct);
  const ad = new TextEncoder().encode(pathHashHex);
  const decrypted = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    body,
    ad,
    nonce,
    keys.content_key,
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

const VERIFIER_CONSTANT = "geode-verifier-v1";

export async function makeVerifier(keys: VaultKeys): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(24);
  const pt = new TextEncoder().encode(VERIFIER_CONSTANT);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pt,
    null,
    null,
    nonce,
    keys.content_key,
  );
  return seal(nonce, ct);
}

export async function checkVerifier(keys: VaultKeys, blob: Uint8Array): Promise<boolean> {
  try {
    const sodium = await getSodium();
    const { nonce, ct } = open(blob);
    const dec = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      null,
      nonce,
      keys.content_key,
    );
    return new TextDecoder().decode(dec) === VERIFIER_CONSTANT;
  } catch {
    return false;
  }
}

// Nonce‖ciphertext framing shared by every sealed payload. Format is fixed:
// 24-byte nonce then ciphertext (XChaCha20-Poly1305 adds its own 16-byte tag).
function seal(nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return out;
}

function open(sealed: Uint8Array): { nonce: Uint8Array; ct: Uint8Array } {
  if (sealed.length < 24 + 16) {
    throw new Error("invalid ciphertext length");
  }
  return { nonce: sealed.slice(0, 24), ct: sealed.slice(24) };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
