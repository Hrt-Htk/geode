// Bench-only entry for #457: bundles core/crypto.ts (the exact chunk-crypto code and
// libsodium build the plugin ships: see build-bundle.ts) into an IIFE that the E2E
// specs inject into the real Obsidian renderer. Never imported from production code.
// Build: deno task build:plugin && deno run -A test/bench/build-bundle.ts
import { decryptChunk, deriveKeys, encryptChunk } from "../../core/crypto.ts";

type Argon2Opts = {
  kind: "argon2";
  passphrase: string;
  saltB64: string;
  ops: number;
  memMiB: number;
  runs: number;
};
type ThroughputOpts = { kind: "throughput"; passphrase: string; saltB64: string };
export type BenchOpts = Argon2Opts | ThroughputOpts;

type Argon2Run = { index: number; ms: number; status: string };
type Argon2Result = {
  kind: "argon2";
  ops: number;
  memMiB: number;
  runs: Argon2Run[];
  medianMs: number | null;
};
type BucketResult = {
  label: string;
  sizeBytes: number;
  count: number;
  bytes: number;
  ms: number;
  mbPerSec: number;
};
type ThroughputResult = {
  kind: "throughput";
  totalBytes: number;
  totalMs: number;
  mbPerSec: number;
  buckets: BucketResult[];
  networkMeasured: false;
  networkNote: string;
};
export type BenchResult = Argon2Result | ThroughputResult;

const NETWORK_NOTE =
  "network not measured: on-device timing over adb reverse is meaningless; crypto-only";

// FastCDC sizes from core/chunker.ts: min 64 KB, avg 256 KB, max 1 MB.
const BUCKETS = [
  { label: "64KB (min)", size: 64 * 1024, count: 100 },
  { label: "256KB (avg)", size: 256 * 1024, count: 128 },
  { label: "1MB (max)", size: 1024 * 1024, count: 25 },
];
const HASH_HEX = "0".repeat(64);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function medianMs(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function mbPerSec(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  return Math.round(((bytes / 1024 / 1024) / (ms / 1000)) * 10) / 10;
}

async function runArgon2(opts: Argon2Opts): Promise<Argon2Result> {
  const salt = b64ToBytes(opts.saltB64);
  const runs: Argon2Run[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const t0 = performance.now();
    let status = "ok";
    try {
      await deriveKeys(opts.passphrase, salt, {
        opsLimit: opts.ops,
        memLimit: opts.memMiB * 1024 * 1024,
      });
    } catch (e) {
      status = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    runs.push({ index: i, ms: round1(performance.now() - t0), status });
  }
  return {
    kind: "argon2",
    ops: opts.ops,
    memMiB: opts.memMiB,
    runs,
    medianMs: medianMs(runs.filter((r) => r.status === "ok").map((r) => r.ms)),
  };
}

// Deterministic pseudo-random bytes (LCG): non-zero data for realistic AEAD
// throughput without crypto.getRandomValues' cost.
function makeChunk(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

async function runThroughput(opts: ThroughputOpts): Promise<ThroughputResult> {
  // Fast KDF params: this bench measures chunk crypto, not key derivation.
  const keys = await deriveKeys(opts.passphrase, b64ToBytes(opts.saltB64), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const buckets: BucketResult[] = [];
  let totalBytes = 0;
  let totalMs = 0;
  for (let b = 0; b < BUCKETS.length; b++) {
    const { label, size, count } = BUCKETS[b];
    let ms = 0;
    for (let i = 0; i < count; i++) {
      const pt = makeChunk(size, b * 1000 + i);
      const t0 = performance.now();
      const ct = await encryptChunk(pt, keys, HASH_HEX);
      const back = await decryptChunk(ct, keys, HASH_HEX);
      if (back.length !== pt.length) throw new Error("round-trip length mismatch");
      ms += performance.now() - t0;
    }
    const bytes = size * count;
    totalBytes += bytes;
    totalMs += ms;
    buckets.push({
      label,
      sizeBytes: size,
      count,
      bytes,
      ms: round1(ms),
      mbPerSec: mbPerSec(bytes, ms),
    });
  }
  return {
    kind: "throughput",
    totalBytes,
    totalMs: round1(totalMs),
    mbPerSec: mbPerSec(totalBytes, totalMs),
    buckets,
    networkMeasured: false,
    networkNote: NETWORK_NOTE,
  };
}

(globalThis as { runCryptoBench?: (opts: BenchOpts) => Promise<BenchResult> }).runCryptoBench = (
  opts: BenchOpts,
) => (opts.kind === "argon2" ? runArgon2(opts) : runThroughput(opts));
