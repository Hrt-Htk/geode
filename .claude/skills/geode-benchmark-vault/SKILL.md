---
name: geode-benchmark-vault
description: >
  Validate a Geode sync-affecting change against REAL vault data before merge/release: project-scoped
  to the Geode repo. Use as the benchmark-vault gate for changes under plugin/sync, core/, or the
  reconciler/merge/apply paths. Drives the real sync engine (reconciler/commit/apply/merge) via the
  two-vault driver seeded read-only from a real vault in place, and checks on-disk convergence.
---

# Geode benchmark-vault gate

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`): `set -a; . .env.local; set +a` before the commands below. This is the
HARD-RULE gate for sync changes: `deno test` + fuzz green is NOT enough: real vaults have CRLF,
binaries, real `.obsidian/`, and accumulated divergence that clean fixtures miss. The reference
driver is committed at `test/bench/bench-real.ts` (not a `*.test.ts`, so `deno test` / `test:ci`
never pick it up).

## Data sources (safety first)
- Benchmark data: a real vault of a few hundred files, at `$GEODE_BENCH_VAULT_DIR`. Restore it from
  your own backup if missing (`rclone copy <remote>:<vault-path> "$GEODE_BENCH_VAULT_DIR"`); a second
  copy of the same vault serves the divergence checks. Hybrid cold-sync seeds from
  `$GEODE_SEED_VAULT_DIR` (usually the same vault).
- **READ ONLY on live vaults**: the harness reads files into memory (FakeVault); it must NEVER write
  to the vault path. Skip `.obsidian/plugins/geode` (a junction to plugin-dist).
- The production server (`$GEODE_PROD_URL`) may be **copied read-only** for a
  resume-against-real-server-state test; **never write actions on prod**. Optional: only the maintainer
  has a production server; the copy is never needed for a gate.

## Approach (driver-based, no real Obsidian)
Model on `test/fuzz/engine.ts` (`runConcurrentSequence`, `settle`, `mapsEqual`) and use `pair()` from
`test/two-vault-driver.ts` (fresh in-memory server + two `TestPlugin`s with `.fakeVault`). Seed device
A's FakeVault from the real files, sync to B, and compare `mapsEqual(A.fakeVault.files, B.fakeVault.files)`,
which is the on-disk `diff -rq` equivalent. To exercise `.obsidian` discovery, set
`A.settings.syncObsidianConfig = true` before `A.start()` (B gets `.obsidian` files only via the real
discover→commit→apply path, since `getAllLoadedFiles` excludes them, so convergence there proves the
scan works).

**`settle()` must wait for application, not just a stable server count.** After the count stabilizes, call `A.waitForCaughtUp(maxSeq)` / `B.waitForCaughtUp(maxSeq)` (driver) before comparing, or large multi-chunk blobs are compared mid-apply.

## The three checks (each PASS/FAIL with concrete numbers)
1. **First-sync convergence**: seed all real `*.md` + a sample of ≤20 binaries; sync; assert
   `mapsEqual` equal; print divergent paths on failure.
2. **`.obsidian` discovery** (with syncObsidianConfig ON): seed real `.obsidian/` config; assert the
   real files land on B, `workspace.json`/`graph.json` excluded, nested paths handled, op count ≈ file
   count (no storm).
3. **Repeated-conflict accumulation**: pick one real markdown file; 3 turns of concurrent divergent
   edits (A one region, B another); settle each turn; assert convergence + BOTH edits survive (a
   `.conflict` file is OK; a lost edit is NOT); file must not freeze-diverge.

## Run
Point `GEODE_BENCH_VAULT_DIR` (`.env.local`) at a real vault **in place**, with no copy: the script is
read-only by construction (guard test `test/bench/bench-real-readonly.test.ts` fails if it ever gains
a write call), and a run leaves nothing behind.
`deno run -A --no-check test/bench/bench-real.ts`
End the script with `Deno.exit(0)` (open server/timer handles otherwise hang the run).

## Honest limits (state these when reporting a PASS)
- FakeVault **normalizes markdown line endings on write**, so Test 1 does NOT fully reproduce
  CRLF-on-disk convergence: real-Obsidian E2E remains the definitive line-ending gate.
- The 2-device conflict test is a proxy; the true 3-device repro is the fuzz `triple` suite.
So: a green benchmark validates real-content convergence + real `.obsidian` discovery, but pair it with
fuzz-green and (for UI/line-ending-sensitive changes) real-Obsidian E2E.
