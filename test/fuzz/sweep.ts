// Committed seed-sweep runner for the oracle fuzz suite (#620): one JSON line
// per seed plus a one-line summary, instead of each session writing its own
// sweep script and parsing `FuzzError.message` by hand.
//
// Usage: deno task fuzz:sweep --runner rename --seeds 1-200 [--devices 2|3]
//        [--turns 4] [--ops 2] [--oracle 3|4] [--shard i/n] [--out file.jsonl]
//
// Exits non-zero when a non-quarantined seed fails.

import { dirname } from "@std/path";
import {
  FuzzError,
  matchKnownFailure,
  runConcurrentBinarySequence,
  runConcurrentSequence,
  runRenameSequence,
  runSequence,
  runTripleSequence,
  type TraceEntry,
} from "./engine.ts";

export type RunnerName = "rename" | "seq" | "concurrent" | "binary" | "triple";

const RUNNERS: RunnerName[] = ["rename", "seq", "concurrent", "binary", "triple"];
const OPTIONS = ["runner", "seeds", "devices", "turns", "ops", "oracle", "shard", "out"];

/** Device count per runner; only `rename` takes a `--devices` option. */
const RUNNER_DEVICES: Record<Exclude<RunnerName, "rename">, number> = {
  seq: 1,
  concurrent: 2,
  binary: 2,
  triple: 3,
};

export interface SeedResult {
  seed: number;
  runner: RunnerName;
  devices: number;
  ok: boolean;
  invariant: string | null;
  details: string | null;
  quarantined: boolean;
  opTrace: TraceEntry[];
}

export interface SweepArgs {
  runner: RunnerName;
  first: number;
  last: number;
  devices: 2 | 3;
  turns: number;
  opsPerTurn?: number;
  /** 4 = rename oracle with history links (#587); 3 = default. */
  oracle: 3 | 4;
  shard: { index: number; total: number } | null;
  out: string;
}

export function parseArgs(argv: string[]): SweepArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    const name = flag.replace(/^--/, "");
    if (!OPTIONS.includes(name)) {
      throw new Error(`unknown flag ${flag}: options: ${OPTIONS.map((o) => `--${o}`).join(" ")}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`flag ${flag} needs a value`);
    }
    flags.set(name, value);
  }

  const runner = flags.get("runner") as RunnerName | undefined;
  if (runner === undefined || !RUNNERS.includes(runner)) {
    throw new Error(`--runner is required, one of ${RUNNERS.join(" ")}`);
  }
  const seeds = flags.get("seeds");
  if (seeds === undefined) throw new Error("--seeds is required, e.g. --seeds 1-200");
  const { first, last } = parseRange(seeds);

  if (runner !== "rename") {
    for (const renameOnly of ["devices", "oracle"]) {
      if (flags.has(renameOnly)) throw new Error(`--${renameOnly} only applies to --runner rename`);
    }
  }

  const devices = Number(flags.get("devices") ?? 2);
  if (devices !== 2 && devices !== 3) throw new Error("--devices must be 2 or 3");
  const oracle = Number(flags.get("oracle") ?? 3);
  if (oracle !== 3 && oracle !== 4) throw new Error("--oracle must be 3 or 4");

  const base = {
    runner,
    first,
    last,
    devices,
    turns: intFlag(flags.get("turns") ?? "4", "--turns"),
    opsPerTurn: flags.has("ops") ? intFlag(flags.get("ops") ?? "", "--ops") : undefined,
    oracle,
    shard: flags.has("shard") ? parseShard(flags.get("shard") ?? "") : null,
  };
  return { ...base, out: flags.get("out") ?? defaultOut(base) };
}

/** Seed numbers this run covers, thinned to the shard when one is given. */
export function seedsFor(args: SweepArgs): number[] {
  const all = Array.from({ length: args.last - args.first + 1 }, (_, i) => args.first + i);
  const shard = args.shard;
  if (shard === null) return all;
  return all.filter((_, i) => i % shard.total === shard.index);
}

/** Collapse results into the single summary line printed at the end. */
export function formatSummary(
  args: SweepArgs,
  results: SeedResult[],
  elapsedMs: number,
): string {
  const failures = results.filter((r) => !r.ok);
  const invariants: Record<string, number> = {};
  for (const failure of failures) {
    const invariant = failure.invariant ?? "unknown";
    invariants[invariant] = (invariants[invariant] ?? 0) + 1;
  }
  const range = `${args.first}-${args.last}`;
  const seeds = args.shard ? `${range} shard ${args.shard.index}/${args.shard.total}` : range;
  return `summary ${
    JSON.stringify({
      runner: args.runner,
      devices: devicesFor(args),
      seeds,
      passed: results.length - failures.length,
      failed: failures.filter((r) => !r.quarantined).length,
      quarantined: failures.filter((r) => r.quarantined).length,
      total: results.length,
      invariants,
      failing: failures.map((r) => r.seed),
      out: args.out,
      elapsedSec: Math.round(elapsedMs / 1000),
    })
  }`;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  await Deno.mkdir(dirname(args.out), { recursive: true });
  await Deno.writeTextFile(args.out, "");
  const started = Date.now();
  const results: SeedResult[] = [];

  for (const seed of seedsFor(args)) {
    const result = await runSeed(args, seed);
    results.push(result);
    await Deno.writeTextFile(args.out, `${JSON.stringify(result)}\n`, { append: true });
    if (!result.ok) {
      const note = result.quarantined ? " (quarantined)" : "";
      console.log(
        `FAIL seed=${seed} ${result.invariant}: ${(result.details ?? "").split("\n")[0]}${note}`,
      );
    }
  }

  console.log(formatSummary(args, results, Date.now() - started));
  return results.some((r) => !r.ok && !r.quarantined) ? 1 : 0;
}

function devicesFor(args: SweepArgs): number {
  return args.runner === "rename" ? args.devices : RUNNER_DEVICES[args.runner];
}

/** One seed. Only `FuzzError` is a result; anything else is a harness bug and rethrows. */
async function runSeed(args: SweepArgs, seed: number): Promise<SeedResult> {
  const base = { seed, runner: args.runner, devices: devicesFor(args) };
  try {
    await runOnce(args, seed);
    return { ...base, ok: true, invariant: null, details: null, quarantined: false, opTrace: [] };
  } catch (e) {
    if (!(e instanceof FuzzError)) throw e;
    return {
      ...base,
      ok: false,
      invariant: e.invariant,
      details: e.details,
      quarantined: matchKnownFailure(e) !== null,
      opTrace: e.opTrace,
    };
  }
}

function runOnce(args: SweepArgs, seed: number): Promise<void> {
  switch (args.runner) {
    case "rename":
      return runRenameSequence({
        seed,
        turns: args.turns,
        devices: args.devices,
        opsPerTurn: args.opsPerTurn,
        historyLinks: args.oracle === 4,
      });
    case "seq":
      return runSequence({ seed, turns: args.turns, opsPerTurn: args.opsPerTurn ?? 5 });
    case "concurrent":
      return runConcurrentSequence({ seed, turns: args.turns });
    case "binary":
      return runConcurrentBinarySequence({ seed, turns: args.turns });
    case "triple":
      return runTripleSequence({ seed, turns: args.turns });
  }
}

function defaultOut(args: Omit<SweepArgs, "out">): string {
  const oracle = args.oracle === 4 ? "-oracle4" : "";
  const shard = args.shard ? `-s${args.shard.index}of${args.shard.total}` : "";
  return `tmp/fuzz-sweep/${args.runner}-${args.first}-${args.last}-d${args.devices}-t${args.turns}${oracle}${shard}.jsonl`;
}

function parseRange(spec: string): { first: number; last: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (match === null) throw new Error(`--seeds must be N or N-M, got "${spec}"`);
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (last < first) throw new Error(`--seeds range is backwards: "${spec}"`);
  return { first, last };
}

function parseShard(spec: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (match === null) throw new Error(`--shard must be i/n, got "${spec}"`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index >= total) throw new Error(`--shard needs i < n, got "${spec}"`);
  return { index, total };
}

function intFlag(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return n;
}

if (import.meta.main) {
  // Runners leave server sockets and timers behind; exit rather than hang.
  Deno.exit(await main(Deno.args));
}
