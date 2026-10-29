import { blake3Hex } from "./hash.ts";
import { decryptChunk, VaultKeys } from "./crypto.ts";
import { mapWithConcurrency } from "./concurrency.ts";

const CHUNK_FETCH_LIMIT = 8;

export class IntegrityError extends Error {}

export async function reassemble(
  chunkHashes: string[],
  keys: VaultKeys,
  fetchBlob: (hash: string) => Promise<Uint8Array>,
  expectedPlaintextHash: string,
): Promise<Uint8Array> {
  const parts = await mapWithConcurrency(
    chunkHashes,
    CHUNK_FETCH_LIMIT,
    (h) => fetchBlob(h).then((enc) => decryptChunk(enc, keys, h)),
  );
  const out = concatBytes(parts);
  if (blake3Hex(out) !== expectedPlaintextHash) {
    throw new IntegrityError(
      `reassembled hash ${blake3Hex(out)} != expected ${expectedPlaintextHash}`,
    );
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
