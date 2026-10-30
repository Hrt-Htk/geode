---
covers: []
watches: [test/e2e/scenarios/**, test/fuzz/**, test/unit/fuzz-sweep.test.ts]
---

# Progressive E2E campaign (levels of realism)

**Depends on:** `e2e-playwright.md` (the harness this ladder climbs), `step-gates.md` (the gates it
complements), `strategy.md` §2 (the in-process scenario layer).

A ladder from "one device survives an interruption" to "a phone and a desktop converge from a cold
start". Each level names specs that run.

| Level | What it proves                                                               | Where it runs                                                                                                              |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **0** | One device: create, auto-save, kill, external edit and restart lose nothing. | `test/e2e/scenarios/level0-single-device.spec.ts` (desktop)                                                                |
| **1** | Two devices converge; normal churn loses nothing.                            | `gate4-basic-sync.spec.ts` (+ `.hybrid`), `login-add-modify-both-ways.spec.ts` (+ `.hybrid`)                               |
| **2** | Merge and conflict files on real markdown; nothing lost.                     | `gate5-*.spec.ts` (+ `.hybrid`), `conflicts-flow.spec.ts`, `rename-vs-edit.hybrid.spec.ts`                                 |
| **3** | Kill and restart mid-sync under load; no data loss, no duplicate versions.   | `interrupt-*.spec.ts` (+ `.phone` / `.hybrid`), `data-loss-revert-on-restart.spec.ts`, `cold-sync-progress.hybrid.spec.ts` |
| **4** | Mobile adapter and phone/desktop hybrid; state persistence on the device.    | `*.phone.spec.ts`, `*.hybrid.spec.ts`; device runbook in `e2e-playwright.md` §5                                            |
| **5** | Randomised oracle: sweep op sequences with chaos injection.                  | `test/fuzz/` (see Level 5 below)                                                                                           |

Level 4 covers the place FakeVault cannot model: the phone's Capacitor FS bridge. Level 5 is a
model-based oracle over FakeVault, so it checks sync logic and invariants rather than the real
filesystem.

---

## Level 0: single-device sanity

Goal: one device survives every "the editor closed / the process died" interruption with no loss, no
duplicate versions and no conflict files.

`level0-single-device.spec.ts` has three tests, all against a real desktop Obsidian:

- **0a: clean create, commit, restart.** Create three notes in three folders, commit, then restart.
  Files are byte-identical afterwards, `getLastSeenSeq()` is above 0 before and after (the cursor is
  re-established, not reset to 0), and no conflict file appears.
- **0b: kill mid-debounce.** A note is seeded and synced, then five lines are written and the app is
  "killed" before the 2 s pending window fires. On relaunch the five lines are on disk and propagate
  to the peer exactly once: the path's server chain holds exactly two versions (the seed and the
  recovered write), with no conflict file.
- **0c: restart with an untracked local edit.** With the app locked, an external write appends three
  lines. On unlock the reconciler detects the change and commits a version that reaches the peer;
  `getLastSeenSeq()` advances past 1; no conflict file.

The "restart" in 0a and 0b is a state re-session, not an OS process kill. The fixtures create a
fresh vault per launch, so the specs call `lockVault()` then `unlockVault(passphrase)`: lock clears
the in-memory runtime, unlock reloads the persisted state (`local-files.json`, `sync-cursor.json`,
the version cache) through `openSessionState()` / `openStateDB()`, the same path a real restart
uses. Parent-chain correctness is asserted in the scenario layer (`test/scenarios/`), not from the
app.

---

## Standing invariants

There is no shared invariants module. The invariants live where they can be enforced:

| Invariant                                                        | Enforced by                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Two devices end up byte-identical                                | `waitForConvergence` / `waitForContent` in every convergence spec; the scenario layer asserts it on `FakeVault`                   |
| A resync or reconcile cycle adds no version and no conflict file | `resync-*`, `reconciler-*` and `no-apply-echo` scenarios                                                                          |
| No committed markdown contains conflict markers                  | `test/scenarios/merge/merge-no-marker-commit.test.ts`; the fuzz oracle's `marker-leakage-A/B/C` invariant                         |
| Server seq is monotonic and unique; parent chains are valid      | `test/unit/server/ws-hub.test.ts` (`monotonic seq on insert`, stale-parent conflict); the fuzz oracle's `seq-monotonic` invariant |
| Every row a client can observe matches the oracle                | the fuzz oracle (`oracle-A/B`, `convergence`, `conflict-file-A/B` invariants)                                                     |

---

## Level 5: the oracle fuzz suite

`test/fuzz/engine.ts` runs random op sequences (create, modify, rename, delete, binary, offline
windows, restart and reconnect chaos) against the real sync core on `FakeVault`, and after every
turn compares both devices against an independent model of what should be on disk. A mismatch throws
`FuzzError` with the invariant name, the details and the op trace.

Runners: `runSequence` (single writer plus chaos), `runConcurrentSequence`,
`runConcurrentBinarySequence`, `runTripleSequence`, `runRenameSequence`. Presets: `daily-cycle`,
`large-vault`, `offline-conflict`, `restart-storm`, `three-device-fanout`, `rename-storm`.
Multi-seed sweeps go through `deno task fuzz:sweep`. A known, triaged bug is quarantined in
`KNOWN_FAILURES`, never skipped silently. `test/fuzz` is excluded from `deno task test:ci`; run it
for any sync-affecting change.

---

## Adding a level

Add one spec (plus its `.phone` / `.hybrid` twin when the device matters) that asserts the
user-visible outcome, and add a row above. If a level needs a new invariant, put it in the fuzz
oracle or in a `waitFor*` helper, not in a parallel assertion module.
