import { assertEquals } from "@std/assert";
import { chunk } from "../../../core/chunker.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { b64encode, type VersionRecord } from "../../../core/protocol.ts";
import { loadVersionPreview } from "../../../plugin/ui/history-preview.ts";

// #464: what a selected version previews as: markdown text, an image, or a
// dead "PDF · 240 KB · preview not available" line, decided from the version's
// own decrypted metadata before any chunk is fetched.

const PASSPHRASE = "history-preview-pass";
const SALT = new Uint8Array(16).fill(0x42);

type Built = { record: VersionRecord; blobs: Map<string, Uint8Array> };

async function buildVersion(
  keys: VaultKeys,
  path: string,
  mime: string,
  bytes: Uint8Array,
): Promise<Built> {
  const pathHash = hashPathHex(keys.mac_key, path);
  const blobs = new Map<string, Uint8Array>();
  const hashes: string[] = [];
  for (const c of chunk(bytes)) {
    const h = blake3Hex(c);
    hashes.push(h);
    blobs.set(h, await encryptChunk(c, keys, h));
  }
  const meta = { path, mtime: 1, size: bytes.length, mime, plaintext_hash: blake3Hex(bytes) };
  return {
    record: {
      version: 2,
      parent: 1,
      path_hash: pathHash,
      chunk_hashes: hashes,
      enc_metadata: b64encode(await encryptMetadata(meta, keys, pathHash)),
      compacted_range: null,
      path_ciphertext: null,
      device_id: "dev-1",
      seq: 2,
      created_at: 1_700_000_000_000,
      deleted: 0,
    },
    blobs,
  };
}

Deno.test("history-preview - markdown versions preview as their decrypted text", async () => {
  const keys = await deriveKeys(PASSPHRASE, SALT);
  const { record, blobs } = await buildVersion(
    keys,
    "Notes/Meeting notes.md",
    "text/markdown",
    new TextEncoder().encode("# Meeting notes\n\nStarted on the train."),
  );
  const preview = await loadVersionPreview(record, keys, (h) => Promise.resolve(blobs.get(h)!));
  assertEquals(preview, { kind: "text", text: "# Meeting notes\n\nStarted on the train." });
});

Deno.test("history-preview - image versions preview as their bytes and mime", async () => {
  const keys = await deriveKeys(PASSPHRASE, SALT);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { record, blobs } = await buildVersion(
    keys,
    "Attachments/vault-map.png",
    "image/png",
    bytes,
  );
  const preview = await loadVersionPreview(record, keys, (h) => Promise.resolve(blobs.get(h)!));
  assertEquals(preview, { kind: "image", bytes, mime: "image/png" });
});

Deno.test("history-preview - binaries show a type and size line without fetching a chunk", async () => {
  const keys = await deriveKeys(PASSPHRASE, SALT);
  const { record, blobs } = await buildVersion(
    keys,
    "Attachments/scan.pdf",
    "application/pdf",
    new Uint8Array(240 * 1024),
  );
  let fetches = 0;
  const preview = await loadVersionPreview(record, keys, (h) => {
    fetches++;
    return Promise.resolve(blobs.get(h)!);
  });
  assertEquals(preview, { kind: "binary", line: "PDF · 240 KB · preview not available" });
  assertEquals(fetches, 0, "a binary preview must not download its content");
});
