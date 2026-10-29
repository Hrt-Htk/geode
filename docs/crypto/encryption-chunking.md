---
covers: [core/*.ts]
---

# Crypto, chunking, and normalization

Code lives in `core/`. The same TypeScript runs on Deno (the server) and in the Obsidian plugin.

The server imports only `hash.ts` (verifier hash), `crypto.ts` (`authHashHex` for the re-key auth key),
`protocol.ts` (wire types), `compact.ts`, `version.ts` and `log.ts`. All encryption, chunking and path
normalization happen on the client.

---

## 1. Key derivation (`core/crypto.ts`)

One passphrase produces three independent 32-byte keys with Argon2id and HKDF.

```
master_key  = Argon2id(passphrase, salt, ops, mem)          // 32 bytes; ops/mem = the vault's stored params
content_key = HKDF-SHA256(master_key, salt, "geode/content/v1", 32)
mac_key     = HKDF-SHA256(master_key, salt, "geode/mac/v1",     32)   // keyed BLAKE3 of paths
nonce_key   = HKDF-SHA256(master_key, salt, "geode/nonce/v1",   32)   // deterministic nonces
```

`deriveKeys(passphrase, salt, { opsLimit, memLimit })` passes both values to libsodium's
`crypto_pwhash` with `crypto_pwhash_ALG_ARGON2ID13`. There is no parallelism parameter. HKDF comes from
`@noble/hashes`, because sodium's `crypto_kdf_derive_from_key` takes a numeric subkey id and an 8-byte
context instead of string labels.

The three keys give domain separation: a compromise of one key does not recover the others. The salt
alone is useless without the passphrase.

**Argon2id params are per vault** (Hard rule 7). `deriveKeys` uses the vault's stored `ops` and `mem`,
and falls back to libsodium's `OPSLIMIT_MODERATE` and `MEMLIMIT_MODERATE` (256 MB) only when no params
are given. New vaults use Standard (`ops=3`, `mem=256MB`, see below). A vault created before #457 may
still carry `mem=64MB`. A re-key is the only way to change them.

**Measured levels (#457, 2026-10-11)**: argon2id in the real Obsidian renderer with the plugin's
libsodium build, median of 5 runs (`test/e2e/scenarios/bench457-crypto*.spec.ts`, `GEODE_BENCH=1`).
These are observations from that run:

| Level | ops / mem | Desktop (i5-8500) | Galaxy A33 |
|---|---|---|---|
| Lower | 3 / 64 MiB | 163 ms | 222 ms |
| Standard | 3 / 256 MiB | 675 ms | 932 ms |
| Higher | 4 / 512 MiB | 1863 ms | 2533 ms |

No OOM or renderer crash at any level on the A33.

**New vaults use Standard (`ops=3`, `mem=256MB`)**, decided after those numbers (#457).
`NEW_VAULT_ARGON2_PARAMS` in `plugin/plumbing/settings-types.ts` is applied by the create flow and
stored on the device and on the server (`vaults.argon2_ops`, `vaults.argon2_mem`).
`DEFAULT_SETTINGS.argon2Params` stays at `ops=3, mem=64MB`: it only fills a missing field on load, so
an existing vault never silently changes params (Hard rule 7). Joining a vault derives with the server's
stored params; only a vault with none stored falls back to the joining device's params.

**Key storage**: after the first derivation the three keys are cached in Obsidian's per-device local
storage (`app.saveLocalStorage("key-cache", …)`). The cache is valid for `unlockTimeoutHours` (default
24) and is re-checked against the verifier when it is loaded. "Lock vault" and "Leave vault" clear it; a
passphrase change replaces it with the new keys.

### Threat model: offline passphrase brute-force

The server never sees the passphrase or the derived keys. Unlock is verified entirely client-side: a
local verifier blob (`core/crypto.ts` `checkVerifier`) is decrypted with the candidate keys, with no
server round-trip. An attacker who obtains the local plugin data (`.obsidian/plugins/geode/data.json`,
which holds the salt, the verifier and `argon2Params`) can therefore test passphrase guesses offline,
with no rate limit or lockout. The only cost per guess is the Argon2id work factor above.

The KDF work factor, not server gating, is the defense. The params in use raise the per-guess cost while
staying within mobile RAM limits. They slow an attacker; they do not substitute for passphrase entropy.
Choose a strong, high-entropy passphrase.

Settings load as a shallow merge (`{ ...DEFAULT_SETTINGS, ...data }`), so an existing vault keeps
whatever `argon2Params` its `data.json` holds. The hardened default applies only to newly onboarded
vaults. Rewriting an existing vault's params would re-derive its keys and orphan every encrypted blob,
so it is not done automatically; a deliberate params change is a re-key (below).

### API

```ts
// core/crypto.ts
export type VaultKeys = { content_key: Uint8Array; mac_key: Uint8Array; nonce_key: Uint8Array }; // 32 each

export function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  params?: { opsLimit?: number; memLimit?: number },
): Promise<VaultKeys>;

export function encryptChunk(plaintext: Uint8Array, keys: VaultKeys, plaintextHashHex: string): Promise<Uint8Array>;
export function decryptChunk(ciphertext: Uint8Array, keys: VaultKeys, plaintextHashHex: string): Promise<Uint8Array>;

export function encryptMetadata(meta: FileMeta, keys: VaultKeys, pathHashHex: string): Promise<Uint8Array>;
export function decryptMetadata(ct: Uint8Array, keys: VaultKeys, pathHashHex: string): Promise<FileMeta>;

export function encryptPath(path: string, keys: VaultKeys, pathHashHex: string): Promise<Uint8Array>;
export function decryptPath(ct: Uint8Array, keys: VaultKeys, pathHashHex: string): Promise<string>;

export function makeVerifier(keys: VaultKeys): Promise<Uint8Array>;
export function checkVerifier(keys: VaultKeys, blob: Uint8Array): Promise<boolean>;

// #556: the re-key session auth key. The server stores only authHashHex of it.
export function deriveAuthKey(keys: VaultKeys): Uint8Array;
export function authHashHex(authKey: Uint8Array): string;
```

### Rekeying the vault (passphrase change, strength change)

Changing the passphrase or the argon2 level re-derives all three keys. Every blob, version row and
trash head must be re-encrypted under the new keys and re-uploaded to the **same plaintext-hash ID**
(Hard rules 1 and 2: chunking and nonce derivation never change, only the keys move). The path hash is
keyed by `mac_key`, so every row's `path_hash` is rewritten too. The plugin runs this as a resumable
worker (`plugin/sync/rekey-run.ts`) against the server's re-key session endpoints
(`server/rekey-routes.ts`, `server/rekey-store.ts`), in one of two modes:

- **Copy**: the server creates a hidden staging vault. The worker writes blobs and rows into it, then
  one transaction plus a blob-directory swap replaces the live vault.
- **Replace**: the worker rewrites blobs and rows in place. The server refuses to cancel a replace run;
  only finishing it clears `rekey_mode`. The worker itself can be paused, and sync stays blocked on every
  device until the run is resumed and finished.

While a re-key session is open the server refuses commits and blob uploads, so no device can sync.

In copy mode the switch is written last (new verifier, argon2 params, auth hash, and clearing
`rekey_mode`, in one transaction), so a cancel or crash before it leaves the vault fully on the old
keys. The commit is followed by a blob-directory swap, so a crash can land between the two parts. A
durable intent marker (`blobs/<vaultId>.rekey-switch`, written before the transaction and deleted after
the swap) lets startup recovery finish either part, so the vault never ends on new keys with old blobs.
Replace mode rewrites rows in place, so a crash mid-run leaves part of the vault on new keys; the resume
cursor restarts the run where it stopped. The cursor (`rekey-cursor.json` in the plugin data dir, written
through the device-gated state writer) lets a restart reopen the run paused.

The theoretical in-flight-commit window at the switch (a commit already in a connection's receive queue
when the switch clears `rekey_mode`) is unreachable in practice: the session start sets `rekey_mode`
before closing the live sockets, so any commit in flight at start is refused with
`rekey_in_progress`, and every device pauses its commit queue on the `rekey: true` handshake, so no
commit can be on the wire when the switch lands.

**Trust note**: the re-key session is authorized by an auth key derived from the vault's content key
(`deriveAuthKey`), and the server stores only its hash. During an open re-key session any unlocked
device therefore holds the key to overwrite blobs and rows. The session is trusted device to device,
and the server cannot distinguish the re-key worker from any other unlocked client. The *first* hash
write needs the admin token (`x-geode-admin-token`) as well as the device token, so a stolen device
token cannot claim the re-key surface or the vault's first verifier; every later write is device only.
The KDF params a session installs are bounded (ops 1 to 10, mem 8 MiB to 1 GiB).

---

## 2. Chunk encryption

Algorithm: **XChaCha20-Poly1305** via `libsodium.crypto_aead_xchacha20poly1305_ietf_encrypt`.

- **Nonce (24 bytes)**: `BLAKE3-keyed(nonce_key, plaintext_hash_digest)[:24]`, keyed over the raw
  32-byte hash, not its hex. Deterministic.
- **Plaintext**: the chunk bytes from FastCDC.
- **AD (additional data)**: empty for chunks. A chunk's identity is fully determined by its content
  hash, and nothing else binds to it.
- **Ciphertext layout**: `nonce (24) || ciphertext (n) || tag (16)`. The server stores the whole blob.
  The client splits off the nonce to decrypt, and `decryptChunk` rejects a stored nonce that does not
  match the expected one (wrong plaintext hash).

**Why a deterministic nonce is safe here**: the nonce depends on the plaintext hash and the key is
constant per vault, so the same plaintext always produces the same nonce and the same ciphertext. Two
different plaintexts get different nonces (barring a hash collision), so a key never encrypts two
different messages under one nonce. Two devices encrypting the same plaintext compute the same blob byte
for byte, so dedup works on the bytes (not just on the hash).

**Why not random nonces**: dedup would still work (the hash is over the plaintext, not the ciphertext),
but the first uploader's blob wins and the second uploader's ciphertext is silently discarded. That
wastes work, and a re-uploader cannot check whether the server holds its ciphertext.

**Confirmation-of-file threat model (accepted)**: blob IDs are unkeyed BLAKE3 plaintext hashes, so the
server can confirm membership of a known plaintext by chunking it (same FastCDC, same hash) and checking
whether those hashes already exist. That is a file-equality oracle the server can probe without
decrypting anything. It weakens the "server never sees plaintext" property but is inherent to
content-addressed dedup, and changing it would break every existing vault (Hard rules 1 and 2). The
server still learns nothing about content or paths and cannot decrypt anything.

### Metadata and path encryption

`enc_metadata` uses XChaCha20-Poly1305 too, with `pathHashHex` as the AD. That binds the metadata to its
path, so an attacker cannot swap encrypted metadata between paths even with control of the server.

```ts
type FileMeta = {
  path: string; // original NFC-normalized path
  mtime: number; // ms since epoch
  size: number; // bytes of reconstructed plaintext
  mime: string; // for binary/text dispatch
  plaintext_hash: string; // hex BLAKE3 of full reconstructed file, integrity check
  // #583: encrypted rename links. The server only sees the row's rename_mark.
  renamed_to?: string;
  renamed_from?: string;
  renamed_from_version?: number;
};
```

The metadata nonce is 24 random bytes, prepended. Metadata needs no dedup and changes with every
version.

The path itself travels as `path_ciphertext` (migration 008). `encryptPath` seals the NFC path with
`content_key`, a nonce derived from `pathHashHex`, and the path hash as AD. That is the same
construction as metadata, so the server indexes by `path_hash` and never learns a path.

---

## 3. FastCDC chunker (`core/chunker.ts`)

### Why FastCDC, not fixed-size

Fixed-size chunking loses all dedup on an insertion: one byte at the top of a file shifts every chunk
boundary, so no chunk matches the previous version and the whole file is re-uploaded.

Content-defined chunking anchors boundaries to a rolling hash over the preceding bytes. An edit only
changes the chunks around it; chunks before the edit keep their identity, and the following chunks
re-sync on real file content.

Reference: Wen Xia et al., 2016.

### Parameters

```ts
const MIN_SIZE = 64 * 1024; // 64 KB: chunks below this are not split
const AVG_SIZE = 256 * 1024; // 256 KB: target average
const MAX_SIZE = 1 * 1024 * 1024; // 1 MB: hard ceiling
const MASK_S = 0x1ffn; // 9 bits: cut probability 1/512 in [min, avg]
const MASK_L = 0x7ffn; // 11 bits: cut probability 1/2048 in [avg, max]
```

These values set the dedup ratio and the per-chunk overhead. They are fixed for v1: changing them is a
protocol break, because every device's chunk boundaries would shift. Treat a change as v2.

`GEAR` is 256 deterministic 64-bit values, generated at module load by a seeded LCG from the reference
implementation's seed. It is a fixed table, not random data, so every implementation derives identical
boundaries.

### Algorithm

```ts
export function* chunk(input: Uint8Array): Generator<Uint8Array> {
  let pos = 0;
  while (pos < input.length) {
    const end = findCutPoint(input, pos); // FastCDC core
    yield input.subarray(pos, end);
    pos = end;
  }
}

function findCutPoint(buf: Uint8Array, start: number): number {
  const end = Math.min(buf.length, start + MAX_SIZE);
  let hash = 0n;
  let i = Math.min(end, start + MIN_SIZE);
  const avgEnd = Math.min(end, start + AVG_SIZE);
  // Stricter mask phase: prefer a boundary in [min, avg]
  for (; i < avgEnd; i++) {
    hash = (hash << 1n) + GEAR[buf[i]];
    if ((hash & MASK_S) === 0n) return i + 1;
  }
  // Looser mask phase: take any boundary in [avg, max]
  for (; i < end; i++) {
    hash = (hash << 1n) + GEAR[buf[i]];
    if ((hash & MASK_L) === 0n) return i + 1;
  }
  return end;
}
```

The `BigInt` arithmetic is deliberate: a 64-bit rolling hash. Do not replace it with a JS number.

### API

```ts
export function* chunk(input: Uint8Array): Generator<Uint8Array>;
```

### Chunk upload

`uploadChunks` (`plugin/sync/commit.ts`) keeps only the plaintext hashes. It hashes each chunk with
BLAKE3, sends a `HEAD` for that hash, encrypts and uploads the chunk when the server does not have it,
and returns the hash list for the commit. The plaintext chunk bytes are dropped after upload.

---

## 4. Hashing (`core/hash.ts`)

Single library: `@noble/hashes/blake3`. Pure JS, works in Node, Deno and browsers.

```ts
export function blake3Hex(data: Uint8Array): string; // 64 hex chars
export function blake3Keyed(key: Uint8Array, data: Uint8Array): Uint8Array; // 32 bytes raw
export function blake3KeyedHex(key: Uint8Array, data: Uint8Array): string;
export function hashPathHex(macKey: Uint8Array, normalizedPath: string): string;
```

**`path_hash`**: callers normalize first, then hash.

```ts
const pathHash = hashPathHex(keys.mac_key, normalizePath(path)); // NFC, forward slashes, trimmed
```

Keyed BLAKE3 with a 32-byte key acts as an HMAC. The server can compare `path_hash` for equality and
index by it, but cannot reverse it: different vault keys give different hashes for the same path.

**File identity hash**: `blake3Hex(normalizeForHash(path, bytes))`. Markdown has its BOM stripped and
line endings normalized before hashing; every other type is hashed raw. One function, so the
reconciler, commit and apply all compare the same identity.

---

## 5. Normalization (`core/normalize.ts`)

All helpers are idempotent. They prevent false conflicts.

### Path normalization

```ts
export function normalizePath(path: string): string {
  return path
    .normalize("NFC") // macOS NFD to NFC
    .replace(/\\/g, "/") // Windows backslashes to forward
    .replace(/^\/+/, "") // strip leading slashes (paths are vault-relative)
    .replace(/\/+/g, "/") // collapse repeated slashes
    .trim();
}
```

Case is preserved. Case-insensitive filesystems (Windows, macOS default) are not handled
automatically: renaming `Foo.md` to `foo.md` is a path that differs only by case, and the vault may end
up with the wrong case after sync.

`.trim()` strips whitespace from the whole path, so `" a.md"` and `"a.md "` collide with `"a.md"` (same
path hash, same apply target). Keep it: removing it changes the path hash of any existing file whose
name starts or ends with whitespace (#365).

### Line ending normalization (markdown only)

```ts
export function normalizeMarkdownLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
```

Storage is always LF. Apply writes LF as-is, and Obsidian handles LF on Windows.

### BOM strip (markdown only)

```ts
export function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}
```

Applied on commit through `normalizeForHash`. Never re-added on apply.

### Mime detection

```ts
export function detectMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "canvas":
      return "application/json"; // Obsidian canvas
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "pdf":
      return "application/pdf";
    // ... etc
    default:
      return "application/octet-stream";
  }
}
```

This drives the merge dispatcher: `text/markdown` and `text/plain` take the 3-way text merge, everything
else takes the binary path.

---

## 6. Reassembly + integrity check (`core/reassemble.ts`)

```ts
export async function reassemble(
  chunkHashes: string[],
  keys: VaultKeys,
  fetchBlob: (hash: string) => Promise<Uint8Array>,
  expectedPlaintextHash: string,
): Promise<Uint8Array> {
  const parts = await mapWithConcurrency(
    chunkHashes,
    CHUNK_FETCH_LIMIT /* 8 */,
    (h) => fetchBlob(h).then((enc) => decryptChunk(enc, keys, h)),
  );
  const out = concatBytes(parts); // order preserved
  if (blake3Hex(out) !== expectedPlaintextHash) {
    throw new IntegrityError(`reassembled hash ${blake3Hex(out)} != expected ${expectedPlaintextHash}`);
  }
  return out;
}
```

The check catches chunk-cache corruption, chunker bugs, ordering bugs and blob-store bit rot. It runs on
every reassembly.

---

## 7. Module map (`core/`)

| File | Responsibility |
| --- | --- |
| `protocol.ts` | wire types, `PROTOCOL_VERSION`, rename marks, the `restored` mark, base64 codec (types and tiny helpers only) |
| `crypto.ts` | key derivation, chunk/metadata/path sealing, verifier, re-key auth key, libsodium init |
| `chunker.ts` | FastCDC `chunk` + `findCutPoint` + the GEAR table |
| `hash.ts` | BLAKE3 wrappers, `hashPathHex` |
| `normalize.ts` | path / line-ending / BOM normalization, identity hash input, mime detection |
| `reassemble.ts` | `reassemble` + `IntegrityError` |
| `compact.ts` | the pure compaction planner (which versions fold into which checkpoint) |
| `concurrency.ts` | `mapWithConcurrency`, used by reassembly and the reconciler |
| `log.ts` | structured log entry + sinks (the server prints JSON lines, the plugin ring-buffers) |
| `version.ts` | semver parse/compare + `meetsMinimum` for the version gate |

---

## 8. Invariants

- `deriveKeys(samePassphrase, sameSalt, sameParams)` produces identical keys on Linux, Windows and
  mobile.
- `encryptChunk` of the same plaintext on two devices produces byte-identical ciphertexts.
- FastCDC on the same input produces the same chunk boundaries on all platforms.
- An insertion in the middle of a file leaves every chunk before it unchanged.
- Inserting 1 byte at the start of a file leaves all but the first chunk's hash unchanged on realistic
  input (measured 2026-10-25: 30 of 31 chunks kept on 2 MB of pseudorandom data). The committed test
  for this case is ignored because its repeating `i % 256` input produces duplicate chunk hashes
  (`test/unit/core/chunker.test.ts`).
- `normalizePath("Notes\\foo.md")` and an NFD-encoded path normalize to the documented form.
- `reassemble` throws `IntegrityError` if a chunk is swapped for a same-length wrong chunk.
- Every cryptographic primitive is backed by libsodium (no DIY constructions).
- KDF params are authoritative per vault (Hard rule 7): never change a default that existing vaults
  rely on.
