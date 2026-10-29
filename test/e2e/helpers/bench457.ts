// Shared runner for the #457 crypto benchmark specs (desktop + phone): injects the
// bench bundle into the real Obsidian renderer, times argon2 at three levels and
// chunk-crypto throughput, writes the JSON result, prints a compact table.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BENCH457_SALT_B64 = "B4WsbfyEvRrBUCsOcnp4vg==";
const BENCH457_PASSPHRASE = "bench457-passphrase";
const BUNDLE_PATH = path.resolve(__dirname, "..", "..", "bench", "crypto-bench.bundle.js");
const RUNS_PER_LEVEL = 5;

// Owner levels from issue #457; Higher runs last so a renderer crash is attributable.
const LEVELS = [
  { name: "Lower", ops: 3, memMiB: 64 },
  { name: "Standard", ops: 3, memMiB: 256 },
  { name: "Higher", ops: 4, memMiB: 512 },
];

type Argon2Run = { index: number; ms: number; status: string };
type LevelResult = {
  name: string;
  ops: number;
  memMiB: number;
  runs: Argon2Run[];
  medianMs: number | null;
  crashed?: boolean;
  error?: string;
};
type BucketResult = {
  label: string;
  sizeBytes: number;
  count: number;
  bytes: number;
  ms: number;
  mbPerSec: number;
};
type ThroughputResult =
  | {
    kind: "throughput";
    totalBytes: number;
    totalMs: number;
    mbPerSec: number;
    buckets: BucketResult[];
    networkMeasured: boolean;
    networkNote: string;
  }
  | { crashed: true; error: string };

type Bench457Result = {
  platform: "desktop" | "phone";
  issue: 457;
  generatedAt: string;
  argon2: LevelResult[];
  throughput: ThroughputResult | null;
};

type BenchInstance = {
  eval: <T>(js: string) => Promise<T>;
  close: () => Promise<void>;
};

export async function runBench457(
  instance: BenchInstance,
  platform: "desktop" | "phone",
  outPath: string,
): Promise<Bench457Result> {
  let bundle: string;
  try {
    bundle = readFileSync(BUNDLE_PATH, "utf8");
  } catch {
    throw new Error(
      `missing bench bundle: ${BUNDLE_PATH}: run: deno task build:plugin && deno run -A test/bench/build-bundle.ts`,
    );
  }

  await instance.eval(bundle);
  const ready = await instance.eval<boolean>("typeof globalThis.runCryptoBench === 'function'");
  if (!ready) throw new Error("bench bundle injected but runCryptoBench is not defined");

  const argon2: LevelResult[] = [];
  let crashed = false;
  for (const level of LEVELS) {
    if (crashed) {
      argon2.push({
        ...level,
        runs: [],
        medianMs: null,
        crashed: true,
        error: "skipped: renderer crashed on an earlier level",
      });
      continue;
    }
    try {
      const r = await instance.eval<{
        ops: number;
        memMiB: number;
        runs: Argon2Run[];
        medianMs: number | null;
      }>(
        `globalThis.runCryptoBench(${
          JSON.stringify({
            kind: "argon2",
            passphrase: BENCH457_PASSPHRASE,
            saltB64: BENCH457_SALT_B64,
            ops: level.ops,
            memMiB: level.memMiB,
            runs: RUNS_PER_LEVEL,
          })
        })`,
      );
      argon2.push({ ...level, ...r });
    } catch (e) {
      // A dead renderer (WebView OOM) surfaces as a failed evaluate: record it as a
      // result instead of aborting the whole bench.
      crashed = true;
      argon2.push({ ...level, runs: [], medianMs: null, crashed: true, error: String(e) });
    }
  }

  let throughput: ThroughputResult | null = null;
  if (!crashed) {
    try {
      throughput = await instance.eval<ThroughputResult>(
        `globalThis.runCryptoBench(${
          JSON.stringify({
            kind: "throughput",
            passphrase: BENCH457_PASSPHRASE,
            saltB64: BENCH457_SALT_B64,
          })
        })`,
      );
    } catch (e) {
      throughput = { crashed: true, error: String(e) };
    }
  }

  const result: Bench457Result = {
    platform,
    issue: 457,
    generatedAt: new Date().toISOString(),
    argon2,
    throughput,
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  printBenchTable(result);
  return result;
}

function printBenchTable(result: Bench457Result): void {
  const lines: string[] = [];
  lines.push(`===== BENCH457: ${result.platform} (${result.generatedAt}) =====`);
  lines.push(`argon2id key derivation, ${RUNS_PER_LEVEL} runs per level (run 0 = cold):`);
  for (const level of result.argon2) {
    if (level.crashed) {
      lines.push(
        `  ${level.name.padEnd(9)} ops=${level.ops} mem=${
          String(level.memMiB).padStart(3)
        } MiB  CRASHED: ${level.error}`,
      );
      continue;
    }
    const runs = level.runs
      .map((r) => `${r.ms}${r.status === "ok" ? "" : `(${r.status})`}`)
      .join(", ");
    lines.push(
      `  ${level.name.padEnd(9)} ops=${level.ops} mem=${
        String(level.memMiB).padStart(3)
      } MiB  ${runs} ms  median=${level.medianMs ?? "n/a"} ms`,
    );
  }
  if (result.throughput === null) {
    lines.push("chunk crypto: skipped (renderer crashed)");
  } else if ("crashed" in result.throughput) {
    lines.push(`chunk crypto: CRASHED: ${result.throughput.error}`);
  } else {
    const t = result.throughput;
    lines.push(
      `chunk crypto: encrypt+decrypt over FastCDC sizes (${
        (t.totalBytes / 1024 / 1024).toFixed(1)
      } MB total):`,
    );
    for (const b of t.buckets) {
      lines.push(
        `  ${b.label.padEnd(12)} x${String(b.count).padStart(3)}  ${
          (b.bytes / 1024 / 1024).toFixed(1).padStart(5)
        } MB  ${String(b.ms).padStart(8)} ms  ${String(b.mbPerSec).padStart(7)} MB/s`,
      );
    }
    lines.push(
      `  ${"total".padEnd(12)}         ${(t.totalBytes / 1024 / 1024).toFixed(1).padStart(5)} MB  ${
        String(t.totalMs).padStart(8)
      } ms  ${String(t.mbPerSec).padStart(7)} MB/s`,
    );
    lines.push(`  (${t.networkNote})`);
  }
  console.log(lines.join("\n"));
}
