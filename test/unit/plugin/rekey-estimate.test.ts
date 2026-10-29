import { assert, assertEquals } from "@std/assert";
import { getRecentLog } from "../../../plugin/plumbing/log.ts";
import {
  copySpaceCheck,
  CRYPTO_RATE_DESKTOP,
  CRYPTO_RATE_PHONE,
  estimateRekey,
  formatEta,
  liveEta,
  probeNetwork,
  probeSample,
  rekeyPlan,
  type RekeyProbeClient,
} from "../../../plugin/ui/rekey-estimate.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

Deno.test("rekey estimate - platform crypto rates match #457", () => {
  assertEquals(CRYPTO_RATE_DESKTOP, 128 * MB);
  assertEquals(CRYPTO_RATE_PHONE, 88 * MB);
});

Deno.test("rekey estimate - tiny vault is a few seconds", () => {
  const secs = estimateRekey({
    vaultBytes: 10 * MB,
    chunkCount: 200,
    rowBatches: 5,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 20,
    bandwidth: 20 * MB,
  });
  // crypto 2*10MB/128MB/s = 0.16s, network 2*10MB/20MB/s = 1s, rtt 405*20ms = 8.1s
  assert(secs > 9 && secs < 9.5, `expected ~9.3s, got ${secs}`);
});

Deno.test("rekey estimate - huge vault sums all three terms", () => {
  const secs = estimateRekey({
    vaultBytes: 100 * GB,
    chunkCount: 100_000,
    rowBatches: 1_000,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 50,
    bandwidth: 50 * MB,
  });
  // crypto 1600s + network 4096s + rtt 10050s = 15746s
  assert(secs > 15_000 && secs < 16_500, `expected ~15746s, got ${secs}`);
});

Deno.test("rekey estimate - zero or unknown bandwidth is infinite", () => {
  const base = {
    vaultBytes: 1 * GB,
    chunkCount: 1_000,
    rowBatches: 10,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 20,
  };
  assertEquals(estimateRekey({ ...base, bandwidth: 0 }), Infinity);
  assertEquals(estimateRekey({ ...base, bandwidth: null }), Infinity);
});

Deno.test("rekey estimate - zero crypto rate is infinite", () => {
  assertEquals(
    estimateRekey({
      vaultBytes: 1 * GB,
      chunkCount: 10,
      rowBatches: 1,
      cryptoRate: 0,
      rttMs: 20,
      bandwidth: 10 * MB,
    }),
    Infinity,
  );
});

Deno.test("rekey estimate - rtt dominates a small vault with many chunks", () => {
  const secs = estimateRekey({
    vaultBytes: 1 * MB,
    chunkCount: 10_000,
    rowBatches: 100,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 100,
    bandwidth: 100 * MB,
  });
  // rtt = 20100 * 0.1s = 2010s; crypto+network < 0.1s
  assert(secs > 2000 && secs < 2011, `expected ~2010s, got ${secs}`);
});

Deno.test("rekey estimate - bandwidth dominates a large vault with few chunks", () => {
  const secs = estimateRekey({
    vaultBytes: 10 * GB,
    chunkCount: 100,
    rowBatches: 10,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 10,
    bandwidth: 10 * MB,
  });
  // network 20GB/10MB/s = 2048s; crypto 160s + rtt 2.1s
  assert(secs > 2048 && secs < 2211, `expected ~2210s, got ${secs}`);
});

Deno.test("rekey estimate - missing rtt drops only the rtt term", () => {
  const withRtt = estimateRekey({
    vaultBytes: 1 * GB,
    chunkCount: 1_000,
    rowBatches: 10,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: 100,
    bandwidth: 10 * MB,
  });
  const withoutRtt = estimateRekey({
    vaultBytes: 1 * GB,
    chunkCount: 1_000,
    rowBatches: 10,
    cryptoRate: CRYPTO_RATE_DESKTOP,
    rttMs: null,
    bandwidth: 10 * MB,
  });
  assertEquals(withRtt - withoutRtt, 201); // 2010 requests * 100ms
});

Deno.test("rekey estimate - copy space check at the margin boundary", () => {
  const needed = 1 * GB * 1.1;
  assertEquals(copySpaceCheck({ vaultBytes: 1 * GB, serverFree: needed }), { ok: true });
  const blocked = copySpaceCheck({ vaultBytes: 1 * GB, serverFree: needed - 1 });
  assert(!blocked.ok);
  assert(typeof blocked.reason === "string" && blocked.reason.length > 0);
  assert(blocked.reason.includes("1.1 GB"), `reason should name the need: ${blocked.reason}`);
});

Deno.test("rekey estimate - copy space check unknown free space is blocked", () => {
  const result = copySpaceCheck({ vaultBytes: 1 * GB, serverFree: null });
  assert(!result.ok);
  assert(typeof result.reason === "string" && result.reason.length > 0);
});

Deno.test("rekey estimate - copy space check plenty of room is ok", () => {
  assertEquals(copySpaceCheck({ vaultBytes: 1 * GB, serverFree: 10 * GB }), { ok: true });
});

Deno.test("rekey estimate - liveEta early with little data", () => {
  assertEquals(liveEta(0, 100_000_000, 5_000), "Working on it");
  assertEquals(liveEta(1_000, 100_000_000, 5_000), "Working on it"); // 0.001% done
  assertEquals(liveEta(50_000, 100_000_000, 5_000), "Working on it"); // 0.05% done
});

Deno.test("rekey estimate - liveEta late refines from the observed rate", () => {
  // 50% done in 10s -> 10s left
  assertEquals(liveEta(50_000_000, 100_000_000, 10_000), "About 1 min left");
  // 25% done in 60s -> 180s left
  assertEquals(liveEta(25_000_000, 100_000_000, 60_000), "About 3:00 left");
  // done
  assertEquals(liveEta(100_000, 100_000, 5_000), "Finishing up");
});

Deno.test("rekey estimate - formatter boundaries", () => {
  assertEquals(formatEta(0), "About 1 min");
  assertEquals(formatEta(45), "About 1 min");
  assertEquals(formatEta(59.4), "About 1 min");
  assertEquals(formatEta(60), "About 1:00");
  assertEquals(formatEta(61), "About 1:01");
  assertEquals(formatEta(3599), "About 59:59");
  assertEquals(formatEta(3600), "About 1 h");
  assertEquals(formatEta(7200), "About 2 h");
  assertEquals(formatEta(Infinity), "Time unknown");
  assertEquals(formatEta(NaN), "Time unknown");
  assertEquals(formatEta(-5), "Time unknown");
});

function fakeClient(opts: {
  pingMs?: number;
  /** Per-call ping delays, cycled; overrides pingMs. */
  pingSeq?: number[];
  pingFails?: boolean;
  blobBytes?: number;
  blobMs?: number;
  blobFails?: boolean;
  blobCount?: number;
}): RekeyProbeClient & { blobCalls: number } {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let pings = 0;
  return {
    blobCalls: 0,
    async ping() {
      if (opts.pingFails) throw new Error("no server");
      await sleep(opts.pingSeq ? opts.pingSeq[pings++ % opts.pingSeq.length] : opts.pingMs ?? 5);
    },
    async getBlob() {
      this.blobCalls++;
      if (opts.blobFails) throw new Error("no blob");
      await sleep(opts.blobMs ?? 10);
      return new Uint8Array(opts.blobBytes ?? MB);
    },
    sampleBlobHashes() {
      return Array.from({ length: opts.blobCount ?? 3 }, (_, i) => `h${i}`);
    },
  };
}

Deno.test("rekey probe - fast client yields rtt and bandwidth", async () => {
  const result = await probeNetwork(fakeClient({ pingMs: 5, blobBytes: MB, blobMs: 25 }));
  assert(result.rttMs !== null && result.rttMs > 0 && result.rttMs < 50, `rtt ${result.rttMs}`);
  // 3MB over ~3*(25-5)ms of transfer = ~50MB/s
  assert(
    result.bandwidth !== null && result.bandwidth > 30 * MB && result.bandwidth < 80 * MB,
    `bw ${result.bandwidth}`,
  );
});

Deno.test("rekey probe - waiting time is not read as slow transfer (#569)", async () => {
  // Small blobs answer within a ping: the timing is all waiting.
  const result = await probeNetwork(fakeClient({ pingMs: 30, blobBytes: 4 * 1024, blobMs: 25 }));
  assert(result.bandwidth !== null && result.bandwidth > 20 * MB, `bw ${result.bandwidth}`);
});

Deno.test("rekey probe - rtt is the typical ping, not the fastest (#569)", async () => {
  const result = await probeNetwork(fakeClient({ pingSeq: [50, 10, 50, 50, 50], blobMs: 5 }));
  assert(result.rttMs !== null && result.rttMs >= 45, `rtt ${result.rttMs}`);
});

Deno.test("rekey probe - prod-shaped vault estimates about 1 h, not 12 h (#569)", async () => {
  // tree on 2026-10-16: 8,378 chunks, 247 MiB, first sampled chunks ~4 KB.
  const probe = await probeNetwork(fakeClient({ pingMs: 250, blobBytes: 3_800, blobMs: 240 }));
  const plan = rekeyPlan({
    vaultBytes: 247 * MB,
    chunkCount: 8_378,
    rowBatches: 120,
    isMobile: false,
    probe,
    serverFree: 10 * GB,
  });
  assertEquals(plan.etaText, "About 1 h");
});

Deno.test("rekey probe sample - first chunk of multi-chunk versions, deduped", () => {
  const versions = [
    { chunk_hashes: ["small"] },
    { chunk_hashes: ["big1", "tail1"] },
    { chunk_hashes: ["big1", "tail2"] },
    { chunk_hashes: ["big2", "mid", "tail3"] },
  ];
  assertEquals(probeSample(versions, ["all"]), ["big1", "big2"]);
});

Deno.test("rekey probe sample - falls back to all chunks without multi-chunk versions", () => {
  assertEquals(probeSample([{ chunk_hashes: ["a"] }], ["a", "b"]), ["a", "b"]);
});

Deno.test("rekey probe - downloads at most 3 blobs", async () => {
  const client = fakeClient({ pingMs: 5, blobBytes: MB, blobMs: 5, blobCount: 5 });
  await probeNetwork(client);
  assertEquals(client.blobCalls, 3);
});

Deno.test("rekey probe - failing client reports unknown, not an error", async () => {
  const result = await probeNetwork(fakeClient({ pingFails: true, blobFails: true }));
  assertEquals(result, { rttMs: null, bandwidth: null });
});

Deno.test("rekey probe - partial failure keeps the working half", async () => {
  const result = await probeNetwork(fakeClient({ pingMs: 5, blobFails: true }));
  assert(result.rttMs !== null && result.rttMs > 0);
  assertEquals(result.bandwidth, null);
});

Deno.test("rekey probe - slow client is bounded to the budget", async () => {
  const start = Date.now();
  const result = await probeNetwork(fakeClient({ pingMs: 10_000, blobMs: 10_000 }));
  const elapsed = Date.now() - start;
  assert(elapsed < 6_000, `probe took ${elapsed}ms`);
  assertEquals(result, { rttMs: null, bandwidth: null });
});

Deno.test("rekey plan - eta text plus copy availability (the choose-phase result)", () => {
  const base = {
    vaultBytes: 10 * MB,
    chunkCount: 200,
    rowBatches: 5,
    isMobile: false,
    probe: { rttMs: 20, bandwidth: 20 * MB },
  };
  const ok = rekeyPlan({ ...base, serverFree: 100 * MB });
  assertEquals(ok.choice, { copy: { available: true, reason: null } });
  assert(ok.etaText.startsWith("About "), `eta ${ok.etaText}`);
  const blocked = rekeyPlan({ ...base, serverFree: 10 });
  assertEquals(blocked.choice.copy.available, false);
  assert(
    blocked.choice.copy.reason?.includes("free space") === true,
    `reason ${blocked.choice.copy.reason}`,
  );
  const unknown = rekeyPlan({ ...base, serverFree: null });
  assertEquals(unknown.choice.copy.available, false);
  assert(
    unknown.choice.copy.reason?.includes("unknown") === true,
    `reason ${unknown.choice.copy.reason}`,
  );
});

Deno.test("rekey plan - zero vault with unknown space blocks copy, time unknown", () => {
  const plan = rekeyPlan({
    vaultBytes: 0,
    chunkCount: 0,
    rowBatches: 0,
    isMobile: true,
    probe: { rttMs: null, bandwidth: null },
    serverFree: null,
  });
  assertEquals(plan.etaText, "Time unknown");
  assertEquals(plan.choice.copy.available, false);
});

function estimateEntry(since: number, msg: string) {
  return getRecentLog().findLast((e) => e.ts >= since && e.msg === `rekey estimate: ${msg}`);
}

Deno.test("rekey probe - logs every ping, every sample and the result (#571)", async () => {
  const since = Date.now();
  await probeNetwork(fakeClient({ pingMs: 5, blobBytes: 64 * 1024, blobMs: 10, blobCount: 7 }));
  const entry = estimateEntry(since, "speed test");
  assert(entry, "no speed test line");
  assertEquals((entry.fields.pings_ms as number[]).length, 5);
  assertEquals((entry.fields.samples as { bytes: number; ms: number }[]).map((s) => s.bytes), [
    65536,
    65536,
    65536,
  ]);
  assertEquals(entry.fields.sample_pool, 7);
  assert(typeof entry.fields.wait_ms === "number", `wait ${entry.fields.wait_ms}`);
  assert(typeof entry.fields.bytes_per_s === "number", `bw ${entry.fields.bytes_per_s}`);
});

Deno.test("rekey plan - logs the formula's terms and the shown text (#571)", () => {
  const since = Date.now();
  const plan = rekeyPlan({
    vaultBytes: 247 * MB,
    chunkCount: 8_378,
    rowBatches: 120,
    isMobile: false,
    probe: { rttMs: 250, bandwidth: Infinity },
    serverFree: 10 * GB,
  });
  const entry = estimateEntry(since, "result");
  assert(entry, "no result line");
  assertEquals(entry.fields.requests, 2 * 8_378 + 120);
  assertEquals(entry.fields.encryption_s, Math.round((2 * 247 * MB) / CRYPTO_RATE_DESKTOP));
  assertEquals(entry.fields.transfer_s, 0);
  assertEquals(entry.fields.waiting_s, Math.round((2 * 8_378 + 120) * 0.25));
  assertEquals(entry.fields.text, plan.etaText);
  assertEquals(entry.fields.chunks, 8_378);
  assertEquals(entry.fields.vault_bytes, 247 * MB);
});

Deno.test("rekey plan - unknown speed logs as unknown, not null (#571)", () => {
  const since = Date.now();
  rekeyPlan({
    vaultBytes: MB,
    chunkCount: 10,
    rowBatches: 1,
    isMobile: true,
    probe: { rttMs: null, bandwidth: null },
    serverFree: null,
  });
  assertEquals(estimateEntry(since, "result")?.fields.transfer_s, "unknown");
});
