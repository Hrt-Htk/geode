import { log } from "../plumbing/log.ts";
import { formatBytes } from "./trash-format.ts";

// Measured rekey crypto rates, bytes/sec (#457): chunk encrypt+decrypt at
// FastCDC sizes, desktop i5-8500 vs Galaxy A33.
export const CRYPTO_RATE_DESKTOP = 128 * 1024 ** 2;
export const CRYPTO_RATE_PHONE = 88 * 1024 ** 2;

export interface RekeyEstimateInput {
  vaultBytes: number;
  chunkCount: number;
  rowBatches: number;
  /** bytes/sec, one of the CRYPTO_RATE_* constants for the platform. */
  cryptoRate: number;
  /** Probed round trip in ms, or null when the probe found none. */
  rttMs: number | null;
  /** Probed download bandwidth in bytes/sec, or null when the probe found none. */
  bandwidth: number | null;
}

interface RekeyEstimateTerms {
  encryptionS: number;
  transferS: number;
  waitingS: number;
  requests: number;
}

/**
 * The estimate's terms in seconds. A missing or zero rate is Infinity: the
 * unknown term makes the total unknown, not guessable.
 */
function estimateTerms(input: RekeyEstimateInput): RekeyEstimateTerms {
  const requests = 2 * input.chunkCount + input.rowBatches;
  return {
    encryptionS: input.cryptoRate > 0 ? (2 * input.vaultBytes) / input.cryptoRate : Infinity,
    transferS: input.bandwidth !== null && input.bandwidth > 0
      ? (2 * input.vaultBytes) / input.bandwidth
      : Infinity,
    waitingS: input.rttMs !== null && input.rttMs > 0 ? (requests * input.rttMs) / 1000 : 0,
    requests,
  };
}

/** Estimated rekey wall time in seconds. */
export function estimateRekey(input: RekeyEstimateInput): number {
  const t = estimateTerms(input);
  return t.encryptionS + t.transferS + t.waitingS;
}

/** A log-friendly number: rounded, or "unknown" when not finite (#571). */
function logNumber(x: number | null): number | string {
  return x !== null && Number.isFinite(x) ? Math.round(x) : "unknown";
}

export interface RekeyProbeClient {
  /** A small existing request, used to time the round trip. */
  ping(): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array>;
  /** Existing blob hashes to sample for the bandwidth measurement. */
  sampleBlobHashes(): string[];
}

export interface NetworkProbe {
  rttMs: number | null;
  /** bytes/sec; Infinity when the transfer time is lost in the round trip. */
  bandwidth: number | null;
}

const PROBE_BUDGET_MS = 4000;
const PING_ATTEMPTS = 5;
const MAX_SAMPLE_BLOBS = 3;

/**
 * Bandwidth samples: the first chunk of a multi-chunk version is a full-size
 * cut (FastCDC min 64 KB), so its timing carries transfer, not just waiting.
 */
export function probeSample(versions: { chunk_hashes: string[] }[], allChunks: string[]): string[] {
  const big = new Set<string>();
  for (const v of versions) if (v.chunk_hashes.length > 1) big.add(v.chunk_hashes[0]);
  return big.size > 0 ? [...big] : allChunks;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function probePings(client: RekeyProbeClient, deadline: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < PING_ATTEMPTS; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const start = performance.now();
    try {
      await withTimeout(client.ping(), remaining);
      samples.push(performance.now() - start);
    } catch {
      // A failed ping is left out; no samples means unknown.
    }
  }
  return samples;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/**
 * Times a few small requests (median round trip) and downloads up to 3
 * sampled blobs; the round trip is taken out of each download so waiting is
 * not read as slow transfer (#569). Pings get half the budget, blobs the
 * rest. Failures yield null, never a thrown error.
 */
export async function probeNetwork(client: RekeyProbeClient): Promise<NetworkProbe> {
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const pings = await probePings(client, Date.now() + PROBE_BUDGET_MS / 2);
  const rttMs = median(pings);
  const pool = client.sampleBlobHashes();
  const samples: { bytes: number; ms: number }[] = [];
  for (const hash of pool.slice(0, MAX_SAMPLE_BLOBS)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const start = performance.now();
    try {
      const blob = await withTimeout(client.getBlob(hash), remaining);
      samples.push({ bytes: blob.length, ms: performance.now() - start });
    } catch {
      // A failed download is excluded from the bandwidth average.
    }
  }
  const bytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  const ms = samples.reduce((sum, s) => sum + s.ms - (rttMs ?? 0), 0);
  const bandwidth = bytes === 0 ? null : ms > 0 ? (bytes / ms) * 1000 : Infinity;
  log.info("rekey estimate: speed test", {
    pings_ms: pings.map(Math.round),
    wait_ms: logNumber(rttMs),
    sample_pool: pool.length,
    samples: samples.map((s) => ({ bytes: s.bytes, ms: Math.round(s.ms) })),
    bytes_per_s: bandwidth === Infinity ? "negligible transfer" : logNumber(bandwidth),
  });
  return { rttMs, bandwidth };
}

export type CopySpaceCheck = { ok: true } | { ok: false; reason: string };

export type RekeyChoice = {
  copy: { available: boolean; reason: string | null };
};

/** Copy is blocked with the #558 space reason; replace is always available. */
export function rekeyChoice(space: CopySpaceCheck): RekeyChoice {
  return {
    copy: space.ok ? { available: true, reason: null } : { available: false, reason: space.reason },
  };
}

export interface RekeyPlanInput {
  vaultBytes: number;
  chunkCount: number;
  rowBatches: number;
  isMobile: boolean;
  probe: NetworkProbe;
  serverFree: number | null;
}

/** The choose-phase result: the ETA text and the copy availability. Pure
 *  apart from the result log line, so the modal only writes the outcome to
 *  the DOM (#559 review, #571). */
export function rekeyPlan(input: RekeyPlanInput): { etaText: string; choice: RekeyChoice } {
  const estimateInput = {
    vaultBytes: input.vaultBytes,
    chunkCount: input.chunkCount,
    rowBatches: input.rowBatches,
    cryptoRate: input.isMobile ? CRYPTO_RATE_PHONE : CRYPTO_RATE_DESKTOP,
    rttMs: input.probe.rttMs,
    bandwidth: input.probe.bandwidth,
  };
  const terms = estimateTerms(estimateInput);
  const seconds = terms.encryptionS + terms.transferS + terms.waitingS;
  const etaText = formatEta(seconds);
  log.info("rekey estimate: result", {
    vault_bytes: input.vaultBytes,
    chunks: input.chunkCount,
    row_batches: input.rowBatches,
    requests: terms.requests,
    encryption_s: logNumber(terms.encryptionS),
    transfer_s: logNumber(terms.transferS),
    waiting_s: logNumber(terms.waitingS),
    total_s: logNumber(seconds),
    text: etaText,
  });
  return {
    etaText,
    choice: rekeyChoice(
      copySpaceCheck({ vaultBytes: input.vaultBytes, serverFree: input.serverFree }),
    ),
  };
}

/** Copy needs about the vault's size free on the server plus a 10% margin. */
export function copySpaceCheck(
  input: { vaultBytes: number; serverFree: number | null },
): CopySpaceCheck {
  if (input.serverFree === null || !Number.isFinite(input.serverFree)) {
    return { ok: false, reason: "Server space unknown. Check the server, then try again." };
  }
  const needed = input.vaultBytes * 1.1;
  if (input.serverFree < needed) {
    return {
      ok: false,
      reason: `Not enough free space on the server. Rekeying needs about ${
        formatBytes(needed)
      } free.`,
    };
  }
  return { ok: true };
}

/** "About M:SS" under an hour, "About N h" beyond, "About 1 min" for the rest. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Time unknown";
  const s = Math.round(seconds);
  if (s < 60) return "About 1 min";
  if (s < 3600) return `About ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `About ${Math.round(s / 3600)} h`;
}

/**
 * Refines the estimate from the observed progress. Too little data to trust
 * the rate yet: a plain "working" line instead of a number.
 */
export function liveEta(doneBytes: number, totalBytes: number, elapsedMs: number): string {
  if (totalBytes <= 0 || doneBytes <= 0 || elapsedMs <= 0) return "Working on it";
  if (doneBytes < totalBytes * 0.01) return "Working on it";
  const remaining = totalBytes - doneBytes;
  if (remaining <= 0) return "Finishing up";
  return `${formatEta((remaining * elapsedMs) / doneBytes / 1000)} left`;
}
