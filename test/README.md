# test/

One line per directory; the naming convention at the bottom is the rule, not a suggestion.

| Path | What it holds |
|------|---------------|
| `unit/core/` · `unit/plugin/` · `unit/server/` | Deno unit tests, one directory per code home they test: `core/`, `plugin/`, `server/`. |
| `unit/e2e/` · `unit/scripts/` | Unit tests for the E2E harness (`test/e2e/` guards, locks, ports) and for repo `scripts/`. |
| `unit/fuzz-sweep.test.ts` | The one unit test outside a home directory: it checks the sweep CLI's arg parsing, shard tiling and summary, which `test:ci` would otherwise never run (`test/fuzz` is excluded). |
| `integration/` (+ `server-ws/`) | A real server process, driven over HTTP/WebSocket by client-side code. |
| `scenarios/` (+ `merge/`, `recovery/`, `sync/`) | The two-vault driver: real reconciler/commit/apply/merge on `FakeVault`. |
| `bench/` | Non-test scripts run by hand (`bench-real`, `bench-rekey`, `soak`, `crypto-bench-entry`, `build-bundle`); `bench-real-readonly.test.ts` is the one Deno test here, guarding them in CI. |
| `fuzz/` | Oracle fuzz engine (`engine.ts`), its committed suite (`engine.test.ts`), and the sweep CLI (`sweep.ts`). `test/fuzz` is excluded from `test:ci`. |
| `e2e/` | Playwright harness: `playwright.config.ts`, `global-setup.ts`, the phone lock/queue, seed and vault guards. |
| `e2e/fixtures/` | Launching real Obsidian (desktop, phone), the throwaway server, pairs and hybrid pairs. |
| `e2e/helpers/` | Spec-level helpers: waits, shots, mobile UI, interrupt/relaunch, rekey runs. `*.deno.ts` are scripts spawned, never imported. |
| `e2e/scenarios/` | The Playwright specs (projects `default`, `phone`, `hybrid`), flat. |
| `e2e/screenshots/` | Screenshot output, gitignored: `<spec>/<project>/`. |
| `helpers/` | Shared Deno-test helpers: byte equality + the mass-delete guard (`bytes.ts`), `serveOnPortZero`, `makeTempDataDir`. |
| `two-vault-driver.ts` | The scenario harness every `scenarios/` and many `unit/plugin/` tests import. |

## Naming convention

- **kebab-case everywhere.** One behavior family per file; no `_`, no camelCase.
- **`.test.ts`**: a Deno test (`deno test` finds it). Test names read `module - behavior` (`scenario: outcome` in `scenarios/`).
- **`.spec.ts`**: a Playwright spec, `test/e2e/scenarios/` only. Project suffix: `.phone.spec.ts` (Android device), `.hybrid.spec.ts` (desktop + phone in one run). Playwright's `testMatch`/`testIgnore` are suffix regexes: a new suffix silently leaves the project, so check `--list` when you add one.
- **`.deno.ts`**: a script a spec or helper spawns as a subprocess (not imported, not collected).
- **`gateN-`**: step-gate evidence only: keep the prefix **only when `docs/testing/step-gates.md`
  cites the spec (or its family) as gate N's evidence**, N = 1-11. Any other number in a spec name is
  an issue number: name the spec after the behavior it asserts.
- **No issue numbers in file names.** Cite the issue in a comment at the top of the file (`// #587 item 3: …`). `git log`/the comment keep provenance; the name describes the behavior.

## Commands

```bash
deno task test:ci                                     # the Deno suite CI runs (excludes test/fuzz)
deno task test                                        # same suite, no timeout wrapper
deno task fuzz:sweep --runner seq --seeds 1-10        # fuzz seeds (see the geode-fuzz skill)
node node_modules/@playwright/test/cli.js test --config=test/e2e/playwright.config.ts --project=default
deno task phone                                       # phone queue/lock CLI; phone + hybrid runs
```
