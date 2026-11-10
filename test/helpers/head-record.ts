// A server head for tests that drive apply (and a rebuild) from a real heads stream: the
// encrypted metadata and the blobs its content needs, built from a plain text spec.

import { b64encode, type FileMeta, type HeadRecord, RENAME_MARKER } from "../../core/protocol.ts";
import { encryptChunk, encryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../core/hash.ts";
import { normalizeForHash } from "../../core/normalize.ts";
import { chunk } from "../../core/chunker.ts";

export type HeadSpec = {
  path: string;
  version: number;
  seq: number;
  /** A rename marker closes `path` and points at `renamedTo`. */
  renamedTo?: string;
  /** The head's content; a marker has none. */
  body?: string;
};

/** One head, with the encrypted blobs of its content added to `blobs`. */
export async function headRecord(
  vaultKeys: VaultKeys,
  spec: HeadSpec,
  blobs: Map<string, Uint8Array>,
): Promise<HeadRecord> {
  const encoder = new TextEncoder();
  const pathHash = hashPathHex(vaultKeys.mac_key, spec.path);
  const normalized = normalizeForHash(spec.path, encoder.encode(spec.body ?? ""));
  const chunkHashes: string[] = [];
  for (const part of chunk(normalized)) {
    const hash = blake3Hex(part);
    chunkHashes.push(hash);
    blobs.set(hash, await encryptChunk(part, vaultKeys, hash));
  }
  const meta: FileMeta = {
    path: spec.path,
    mtime: 1,
    size: spec.body?.length ?? 0,
    mime: spec.body === undefined ? "" : "text/markdown",
    plaintext_hash: spec.body === undefined ? "" : blake3Hex(normalized),
    renamed_to: spec.renamedTo,
  };
  return {
    path_hash: pathHash,
    version: spec.version,
    seq: spec.seq,
    enc_metadata: b64encode(await encryptMetadata(meta, vaultKeys, pathHash)),
    chunk_hashes: chunkHashes,
    deleted: spec.renamedTo !== undefined,
    path_ciphertext: null,
    rename_mark: spec.renamedTo === undefined ? 0 : RENAME_MARKER,
  };
}
