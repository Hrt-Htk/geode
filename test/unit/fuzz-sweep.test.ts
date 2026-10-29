// Unit tests for the committed fuzz sweep runner (#620): flag parsing, shard
// partitioning, and the one-line summary. Lives outside test/fuzz because
// `test:ci` ignores test/fuzz: the runner itself is still exercised by real
// sweeps (skill `geode-fuzz`).

import { assertEquals, assertThrows } from "@std/assert";
import { formatSummary, parseArgs, type SeedResult, seedsFor } from "../../test/fuzz/sweep.ts";

Deno.test("parseArgs: rename sweep with defaults", () => {
  const args = parseArgs(["--runner", "rename", "--seeds", "1-200"]);
  assertEquals(args.runner, "rename");
  assertEquals([args.first, args.last], [1, 200]);
  assertEquals(args.devices, 2);
  assertEquals(args.turns, 4);
  assertEquals(args.oracle, 3);
  assertEquals(args.shard, null);
  assertEquals(args.out, "tmp/fuzz-sweep/rename-1-200-d2-t4.jsonl");
});

Deno.test("parseArgs: every option, and the out name carries each knob", () => {
  const args = parseArgs([
    "--runner",
    "rename",
    "--seeds",
    "1-100",
    "--devices",
    "3",
    "--turns",
    "8",
    "--ops",
    "3",
    "--oracle",
    "4",
    "--shard",
    "1/2",
    "--out",
    "/tmp/x.jsonl",
  ]);
  assertEquals(
    [args.devices, args.turns, args.opsPerTurn, args.oracle],
    [3, 8, 3, 4],
  );
  assertEquals(args.shard, { index: 1, total: 2 });
  assertEquals(args.out, "/tmp/x.jsonl");

  const derived = parseArgs([
    "--runner",
    "rename",
    "--seeds",
    "1-100",
    "--devices",
    "3",
    "--oracle",
    "4",
    "--shard",
    "0/2",
  ]);
  assertEquals(derived.out, "tmp/fuzz-sweep/rename-1-100-d3-t4-oracle4-s0of2.jsonl");
});

Deno.test("parseArgs: single seed and fixed-device runners", () => {
  assertEquals(parseArgs(["--runner", "triple", "--seeds", "7"]).last, 7);
  const seq = parseArgs(["--runner", "seq", "--seeds", "1-5", "--turns", "8"]);
  assertEquals([seq.runner, seq.turns], ["seq", 8]);
});

Deno.test("parseArgs: rejects bad input", () => {
  assertThrows(() => parseArgs(["--seeds", "1-5"]), Error, "--runner");
  assertThrows(() => parseArgs(["--runner", "nope", "--seeds", "1-5"]), Error, "--runner");
  assertThrows(() => parseArgs(["--runner", "rename"]), Error, "--seeds");
  assertThrows(() => parseArgs(["--runner", "rename", "--seeds", "5-1"]), Error, "--seeds");
  assertThrows(() => parseArgs(["--runner", "rename", "--seeds", "a-b"]), Error, "--seeds");
  assertThrows(
    () => parseArgs(["--runner", "rename", "--seeds", "1-5", "--shard", "2/2"]),
    Error,
    "--shard",
  );
  assertThrows(
    () => parseArgs(["--runner", "seq", "--seeds", "1-5", "--devices", "3"]),
    Error,
    "--devices",
  );
  assertThrows(
    () => parseArgs(["--runner", "seq", "--seeds", "1-5", "--oracle", "4"]),
    Error,
    "--oracle",
  );
  assertThrows(
    () => parseArgs(["--runner", "seq", "--seeds", "1-5", "--frobnicate", "1"]),
    Error,
    "--frobnicate",
  );
  assertThrows(() => parseArgs(["--runner", "seq", "--seeds", "1-5", "--turns"]), Error, "--turns");
});

Deno.test("seedsFor: shards partition the range exactly", () => {
  const base = parseArgs(["--runner", "rename", "--seeds", "1-6"]);
  assertEquals(seedsFor(base), [1, 2, 3, 4, 5, 6]);

  const even = seedsFor({ ...base, shard: { index: 0, total: 2 } });
  const odd = seedsFor({ ...base, shard: { index: 1, total: 2 } });
  assertEquals(even, [1, 3, 5]);
  assertEquals(odd, [2, 4, 6]);
  assertEquals([...even, ...odd].sort((a, b) => a - b), seedsFor(base));
});

Deno.test("formatSummary: one line with pass counts, per-invariant counts, failing seeds", () => {
  const args = parseArgs(["--runner", "rename", "--seeds", "1-4"]);
  const result = (seed: number, invariant: string | null, quarantined = false): SeedResult => ({
    seed,
    runner: "rename",
    devices: 2,
    ok: invariant === null,
    invariant,
    details: invariant === null ? null : `boom ${seed}`,
    quarantined,
    opTrace: [],
  });
  const line = formatSummary(
    args,
    [
      result(1, null),
      result(2, "rename-convergence"),
      result(3, null),
      result(4, "rename-no-edit-lost", true),
    ],
    42_000,
  );

  assertEquals(line.split("\n").length, 1);
  const summary = JSON.parse(line.slice(line.indexOf("{")).trim());
  assertEquals(summary, {
    runner: "rename",
    devices: 2,
    seeds: "1-4",
    passed: 2,
    failed: 1,
    quarantined: 1,
    total: 4,
    invariants: { "rename-convergence": 1, "rename-no-edit-lost": 1 },
    failing: [2, 4],
    out: "tmp/fuzz-sweep/rename-1-4-d2-t4.jsonl",
    elapsedSec: 42,
  });
});
