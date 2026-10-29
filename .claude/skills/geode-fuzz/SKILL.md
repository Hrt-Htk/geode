---
name: geode-fuzz
description: >
  Run and triage Geode's oracle fuzz suite (test/fuzz/): project-scoped to the Geode repo. Use
  when running fuzz seeds, reproducing a fuzz-found bug, validating a sync change, checking a
  quarantine entry, or running the restart-storm regression gate. Encodes the deno path,
  noise-stripping, seed/mode filters, the quarantine model, and expected runtimes.
---

# Geode fuzz suite

Project-scoped to the Geode repo. The oracle fuzz engine lives in `test/fuzz/engine.ts`
(PRNG, content corpus, op model, oracle, invariants, runners) with `test/fuzz/engine.test.ts` the
committed suite. Don't re-derive this each time.

## Fixed facts
- **Deno:** `deno` on PATH.
- Runners in `engine.ts`: `runSequence` (single-writer + chaos), `runConcurrentSequence` (2-device
  markdown), `runConcurrentBinarySequence` (2-device binary), `runTripleSequence` (3-device),
  `runRenameSequence` (2-3 device renames).
- Multi-seed work goes through **`test/fuzz/sweep.ts`** (`deno task fuzz:sweep`): never write your own
  sweep script or parse `FuzzError.message`.
- Presets: `PRESETS` + `runPreset(preset, startSeed)`: `daily-cycle`, `large-vault`,
  `offline-conflict`, `restart-storm`, `three-device-fanout`.

## Run
- Full committed suite (18 tests, ~9 min):
  `deno test --allow-all --no-check test/fuzz/engine.test.ts`
- One mode/seed (fast iteration: each seed ~18-45s, triple slowest):
  add `--filter "triple seed=3"` (also `seq`, `concurrent`, `binary`).
- **Do NOT loop the full suite while iterating**: filter to the failing case.

## Seed sweeps (`deno task fuzz:sweep`): don't write your own
Sweeps many seeds, writes one JSON line per seed to a file plus one `summary {json}` line. Committed
so a sweep is one command, not an ad-hoc scratch script plus message parsing.

```bash
deno task fuzz:sweep --runner rename --seeds 1-200 --oracle 4            # rename sweep, 2 devices
deno task fuzz:sweep --runner rename --seeds 1-100 --devices 3 --oracle 4
deno task fuzz:sweep --runner rename --seeds 1-200 --shard 0/2          # parallel halves, disjoint
deno task fuzz:sweep --runner triple --seeds 1-20 --turns 6
deno task fuzz:sweep --runner seq --seeds 1-10 --turns 8 --ops 3
```

- `--runner rename|seq|concurrent|binary|triple` → `runRenameSequence|runSequence|runConcurrentSequence|runConcurrentBinarySequence|runTripleSequence`.
- `--seeds N` or `N-M` (required), `--turns` (default 4), `--ops` (opsPerTurn; `seq` defaults 5, else
  the engine default), `--oracle 3|4` (4 = rename history links; rename only), `--devices 2|3` (rename
  only), `--shard i/n` (index-based on the range, so the shards tile it exactly), `--out <file.jsonl>`
  (default `tmp/fuzz-sweep/<runner>-<first>-<last>-d<devices>-t<turns>[-oracle4][-s<i>of<n>].jsonl`).
- Per-seed line, straight from the `FuzzError` fields (no message parsing):
  `{seed, runner, devices, ok, invariant, details, quarantined, opTrace}`. `quarantined` = a
  `matchKnownFailure` hit; `details` is `FuzzError.details`, `opTrace` its `TraceEntry[]`. A
  non-`FuzzError` throw aborts the sweep (harness bug, not a result).
- Summary line: `summary {"runner","devices","seeds","passed","failed","quarantined","total","invariants","failing","out","elapsedSec"}`.
- **Exit 1 when any non-quarantined seed fails**; quarantined seeds are recorded but don't fail the
  run. The CLI exits explicitly (`Deno.exit`) because runners leave handles open.
- Triage: `grep -E '^(FAIL|summary)'` on stdout (server logs still interleave), then
  `jq -c 'select(.ok|not)' <the out file>` for invariants + traces.
- Arg parsing, shard tiling and the summary are unit-tested in `test/unit/fuzz-sweep.test.ts`
  (`test/fuzz` is excluded from `test:ci`, so the test lives outside it).

## Strip the noise (server logs bury the result)
Pipe through:
`| grep -viE "blob put|ws (handleConnection|hello|replay|version)|test server started|blob (delete|get)|\"level\":\"info\""`
then `| grep -iE "ok|FAILED|QUARANTINED|passed|failed|error|leak"`.

## Quarantine model (`KNOWN_FAILURES` in engine.ts)
A caught `FuzzError` is skipped ONLY if it matches `{ invariant, messageIncludes, issue }`,
`matchKnownFailure` checks `err.invariant === kf.invariant && err.message.includes(kf.messageIncludes)`.
- Key `messageIncludes` on a substring UNIQUE to the failing runner. Example: a 3-device divergence
  uses invariant `"settle-non-termination"` with `"devices not converged"`: that substring is
  settleTriple-only (the 2-device `settle()` says `"final version count:"`), so it won't mask 2-device
  failures.
- **Never widen/weaken an invariant to go green**: quarantine explicitly, keep the issue open. Filing
  the bug (label `fuzz-found`) and quarantining is the operating model; discovery > green.

## restart-storm = the restart-data-loss regression gate
For any change touching conflict / `localEditPaths` / apply-promotion, run the restart-storm preset,
it exercises restart+reconnect chaos (the "untracked edit survives a restart" scenario). Scratch
script (`tmp/…ts`, end with `Deno.exit(0)` or open server/timer handles hang the run):
```ts
import { PRESETS, runPreset } from "../test/fuzz/engine.ts";
await runPreset(PRESETS["restart-storm"], 1);
console.log("restart-storm: PASSED"); Deno.exit(0);
```
Run: `deno run --allow-all --no-check tmp/<script>.ts`

## Prove a fix DISCRIMINATES (A/B old vs new)
Green-on-new proves the new code passes; it does NOT prove the test would catch the bug. To prove a
sync fix actually discriminates, run the SAME scratch test against the OLD source and confirm it fails:
```
deno run --allow-all --no-check tmp/<probe>.ts        # new: PASS
git checkout main -- plugin/sync/apply.ts plugin/sync/events.ts plugin/sync/sync-manager.ts test/two-vault-driver.ts
deno run --allow-all --no-check tmp/<probe>.ts        # old: reproduces the bug
git checkout HEAD -- plugin/sync/apply.ts plugin/sync/events.ts plugin/sync/sync-manager.ts test/two-vault-driver.ts  # restore
```
This is how a startup apply-echo storm was pinned to a mass apply-echo: N files applied used to
produce N echo commits, now 0. Checkout only the fix's files; `git status` must be clean again after
restore.

## Gotchas
- The suite spins a real `Deno.serve` server + WebSockets; specs set `sanitizeResources:false`. A
  leak-sanitizer failure ("timer never completed" at `VaultHub.scheduleIdle`) is a HARNESS/teardown
  issue, not a convergence bug: the driver's `stop()` must close hubs before `hubStore.clear()`, and
  `scheduleIdle()` guards `_closed`.
- Green here is necessary but NOT sufficient for a sync change: real-data + line-ending behavior needs
  the **geode-benchmark-vault** gate (FakeVault normalizes markdown on write, so line-ending-on-disk
  convergence isn't reproduced here).
