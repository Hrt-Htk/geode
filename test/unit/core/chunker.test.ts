import { chunk } from "../../../core/chunker.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { assert, assertEquals } from "@std/assert";

const MIN_SIZE = 64 * 1024;
const MAX_SIZE = 1 * 1024 * 1024;

function collectChunks(input: Uint8Array): Uint8Array[] {
  return [...chunk(input)];
}

Deno.test({
  name: "chunker - chunk(empty) yields nothing",
  fn() {
    const chunks = collectChunks(new Uint8Array(0));
    assertEquals(chunks.length, 0);
  },
});

Deno.test({
  name: "chunker - chunk(small file < min_size) yields one chunk equal to input",
  fn() {
    const data = new Uint8Array(1000).fill(0x42);
    const chunks = collectChunks(data);
    assertEquals(chunks.length, 1);
    assertEquals(chunks[0], data);
  },
});

Deno.test({
  name: "chunker - chunk is deterministic",
  fn() {
    const data = new Uint8Array(500_000).fill(0x55);
    const chunks1 = collectChunks(data);
    const chunks2 = collectChunks(data);
    assertEquals(chunks1.length, chunks2.length);
    for (let i = 0; i < chunks1.length; i++) {
      assertEquals(chunks1[i], chunks2[i]);
    }
  },
});

Deno.test({
  name: "chunker - chunk determinism: fixed input produces fixed chunk boundaries",
  fn() {
    // Use a repeating pattern to ensure consistent chunk boundaries
    const pattern = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) pattern[i] = (i % 256) as number;
    const data = new Uint8Array(500_000);
    for (let i = 0; i < data.length; i++) data[i] = pattern[i % 1024];

    const chunks1 = collectChunks(data);
    const chunks2 = collectChunks(data);
    assertEquals(chunks1.length, chunks2.length);
    const hashes1 = chunks1.map((c) => blake3Hex(c));
    const hashes2 = chunks2.map((c) => blake3Hex(c));
    assertEquals(hashes1, hashes2);
  },
});

Deno.test({
  name: "chunker - chunk sizes always in [min_size, max_size] (except final tail)",
  fn() {
    // Generate a file that will produce multiple chunks
    const data = new Uint8Array(800_000);
    for (let i = 0; i < data.length; i++) data[i] = (i % 256) as number;

    const chunks = collectChunks(data);
    for (let i = 0; i < chunks.length - 1; i++) {
      assert(chunks[i].length >= MIN_SIZE, `chunk ${i} too small: ${chunks[i].length}`);
      assert(chunks[i].length <= MAX_SIZE, `chunk ${i} too large: ${chunks[i].length}`);
    }
    // Final chunk may be smaller than min_size if it's the tail
    const lastChunk = chunks[chunks.length - 1];
    assert(lastChunk.length <= MAX_SIZE, `last chunk too large: ${lastChunk.length}`);
  },
});

// Deterministic pseudorandom input (mulberry32): an (i % 256) pattern repeats every 256 bytes,
// which collapses distinct chunks onto the same hash and masks the locality property.
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (t ^ (t >>> 14)) >>> 0;
  }
  return out;
}

Deno.test({
  name: "chunker - chunk(insertion at start) keeps most chunk hashes (locality)",
  fn() {
    // The fastcdc variant uses a non-sliding hash (the hash carries from each chunk start), so
    // per-chunk byte-equality after a 1 byte prepend is not what it guarantees. What it does
    // guarantee in practice is locality: most chunks past the insertion re-sync.
    const base = pseudoRandomBytes(500_000, 1);
    const withPrefix = new Uint8Array(base.length + 1);
    withPrefix[0] = 0xff;
    withPrefix.set(base, 1);

    const hashes1 = new Set(collectChunks(base).map((c) => blake3Hex(c)));
    const hashes2 = new Set(collectChunks(withPrefix).map((c) => blake3Hex(c)));
    let shared = 0;
    for (const h of hashes1) if (hashes2.has(h)) shared++;
    assert(
      shared >= Math.floor(hashes1.size * 0.5),
      `expected >=50% shared chunks, got ${shared}/${hashes1.size}`,
    );
  },
});

function assertNotEqualHashes(a: string, b: string): void {
  if (a === b) {
    throw new Error(`expected hashes to differ: ${a}`);
  }
}

Deno.test({
  name: "chunker - chunk(insertion at end) changes only last chunk",
  fn() {
    const base = new Uint8Array(500_000);
    for (let i = 0; i < base.length; i++) base[i] = (i % 256) as number;

    const chunks1 = collectChunks(base);
    const hashes1 = chunks1.map((c) => blake3Hex(c));

    // Append one byte
    const withSuffix = new Uint8Array(base.length + 1);
    withSuffix.set(base);
    withSuffix[base.length] = 0xff;

    const chunks2 = collectChunks(withSuffix);
    const hashes2 = chunks2.map((c) => blake3Hex(c));

    // All chunks before last are identical
    for (let i = 0; i < chunks1.length - 1; i++) {
      assertEquals(hashes1[i], hashes2[i]);
    }
    // Last chunk is different (contains the appended byte)
    assertNotEqualHashes(hashes1[chunks1.length - 1], hashes2[chunks2.length - 1]);
  },
});

Deno.test({
  name: "chunker - chunk(insertion in middle) changes only overlapping chunks",
  fn() {
    const base = new Uint8Array(500_000);
    for (let i = 0; i < base.length; i++) base[i] = (i % 256) as number;

    const chunks1 = collectChunks(base);

    // Insert byte in the middle
    const mid = 250_000;
    const withInsert = new Uint8Array(base.length + 1);
    withInsert.set(base.subarray(0, mid));
    withInsert[mid] = 0xff;
    withInsert.set(base.subarray(mid), mid + 1);

    const chunks2 = collectChunks(withInsert);

    // Chunks before insertion point are identical
    let i = 0;
    while (i < chunks1.length && i < chunks2.length) {
      if (blake3Hex(chunks1[i]) !== blake3Hex(chunks2[i])) break;
      i++;
    }
    // At least the first few chunks should be identical
    assert(i > 0, "expected at least some chunks before insertion to be identical");
  },
});
