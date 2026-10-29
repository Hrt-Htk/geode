---
covers: [test/e2e/playwright.config.ts, test/e2e/global-setup.ts, test/e2e/env.ts, test/e2e/vault-interlock.ts, test/e2e/seed-guard.ts]
watches: [test/e2e/*.ts, test/e2e/fixtures/*, test/e2e/helpers/*, test/unit/e2e/**, test/e2e/scenarios/**]
---

# End-to-end testing with real Obsidian (Playwright)

**Depends on:** `../architecture/plugin.md` (what the plugin exposes), `../architecture/merge.md` §9
(canonical merge scenarios), `strategy.md` §2 (the FakeVault layer this complements),
`step-gates.md` (the gates this layer extends). The ladder of levels is
[`e2e-campaign.md`](./e2e-campaign.md).

This layer drives a real Obsidian instead of the FakeVault mock. It catches what the in-process
scenarios cannot: vault event firing, file-watcher behaviour, plugin lifecycle hooks, CodeMirror
save paths, command-palette wiring, status-bar DOM, conflict files in the real file explorer, and
`.obsidian/plugins/geode/` loading.

Three Playwright projects share one harness: `default` (desktop Electron), `phone` (a real Android
device over ADB and CDP) and `hybrid` (a desktop and the device in one run).

---

## 1. Stack

| Tool                                          | Role                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| **Playwright** (`@playwright/test`)           | Test runner; attaches to Obsidian with `chromium.connectOverCDP()`                |
| **Real Obsidian** (`$OBSIDIAN_BIN`)           | Launched with `--remote-debugging-port=<free port> --user-data-dir=<tmp> <vault>` |
| **Real Deno server**                          | `deno run server/main.ts` on a free port with a fresh temp data dir, one per test |
| **A real Android device** (`phone`, `hybrid`) | `adb` plus the device's own Obsidian, same CDP attach through a forwarded port    |

There is no Obsidian CLI in this harness: everything that is not a DOM assertion goes through
`win.evaluate` in the app's renderer, where `app` is the live Obsidian object. Obsidian and the Deno
server come from `PATH` (`OBSIDIAN_BIN`, `DENO_BIN`); nothing is downloaded.

---

## 2. Layout

```
test/e2e/
├── playwright.config.ts        # projects default/phone/hybrid, workers: 1
├── global-setup.ts             # phone lock + seed/vault guards, frees the fixed port
├── env.ts                      # requireEnv / phoneTestVault (no baked-in defaults)
├── phone-cdp.ts                # eval-on-device over adb + CDP
├── phone-lock.ts               # shared test-phone flock
├── phone-queue.ts              # waiters + ETA for the lock
├── phone-progress-reporter.ts  # publishes holder progress to the lock sidecar
├── server-port.ts              # free the fixed phone-server port
├── seed-guard.ts               # fails a hybrid run early when the seed vault is missing
├── vault-interlock.ts          # refuses a reset unless the open vault is the test vault
├── fixtures/
│   ├── server.ts               # spawn the real server, mint device tokens, restart it
│   ├── obsidian.ts             # launch/prepare/kill a desktop instance, eval, console errors
│   ├── install.ts              # copy plugin-dist into a vault (never symlink)
│   ├── pair.ts                 # one server, two desktop instances
│   ├── fresh.ts                # unconfigured instance, for the setup wizard
│   ├── hybrid-pair.ts          # one server, desktop + phone
│   ├── phone-obsidian.ts       # attach to the device's Obsidian, force-stop, relaunch
│   └── phone-server.ts         # adb reverse / throwaway server for device runs
├── helpers/                    # waits, geode, editor, palette, logs, shots, console-noise,
│                               # device-abstraction, interrupt, rekey, mass-delete seed,
│                               # rename links, fit, verifier, mobile-ui
└── scenarios/                  # the specs, flat; project chosen by file suffix
```

`*.deno.ts` helpers are spawned as subprocesses, never imported. Screenshots land in
`test/e2e/screenshots/<spec>/<project>/` (gitignored).

---

## 3. Fixtures

### 3.1 Server (`fixtures/server.ts`)

`startServer({ env })` spawns the real server on a free port with a temp data dir, creates one
vault, and returns
`{ url, vaultId, salt, dataDir, mintToken(label), registerAuthHash(...), restart(), shutdown(), stop() }`.
`dataDir` is exposed so a spec can open `geode.db` read-only and poll version counts instead of
trusting the status bar. `shutdown()` stops the process and keeps the data dir; `restart()` starts it
again on the same port; `stop()` stops it and deletes the temp dir. A vault the fixture seeds directly
has `auth_hash` NULL, a state no real create or join leaves, so any spec that re-keys must call
`registerAuthHash(deviceToken, passphrase, params)` (admin token included), as the app does;
`launchPair` and `launchHybridPair` call it for you when given a `passphrase` (#675).

### 3.2 Obsidian (`fixtures/obsidian.ts`)

```ts
launchObsidian({ geodeSettings, obsidianBin?, pluginSrcDir?, unlockPassphrase?, keepStartupModal?,
                 seedFiles?, vaultDir?, userDataDir?, prepared?, keepVaultDir?, keepUserDataDir?,
                 pluginVersion? })
  → { app, win, vaultDir, userDataDir, settings, eval, consoleErrors, pluginSettings,
      hardKill, close }
```

Per launch it creates a fresh vault plus a fresh user-data dir, then:

1. writes `.obsidian/community-plugins.json` (`["geode"]`) and `.obsidian/app.json`
   (`safeMode: false`, `trustedAuthors: [<the built manifest's author>]`,
   `settingsPopoutWindow: false`), otherwise Obsidian's restricted mode or trust prompt stops the
   plugin from loading;
2. copies `plugin-dist/` into `.obsidian/plugins/geode/` (a copy, never a symlink: `install.ts` says
   a symlink would route the vault's runtime state back into the shared build dir);
3. writes the test's `GeodeSettings` as the plugin's `data.json`;
4. spawns the app with a free `--remote-debugging-port`, `DBUS_SESSION_BUS_ADDRESS=disabled:` (a
   locked keyring otherwise stalls `requestUrl` for about 25 s) and its own `--user-data-dir`;
5. waits for the DevTools socket, attaches over CDP, waits for `.workspace-leaf`, and dismisses the
   startup modal and trust prompt.

`seedFiles: { sourceDir, count }` copies the first N `.md` files (sorted, `.obsidian` skipped,
mtimes preserved) from a real vault before launch. That is how a cold sync gets a real apply
backlog. `hardKill()` sends SIGKILL mid-operation; `keepVaultDir` plus `prepared` relaunch on the
same vault with its persisted state. `pluginVersion` rewrites the installed manifest so a spec can
drive the version gate.

`consoleErrors()` holds only Geode-originated errors: an entry is kept when its text or stack has a
`plugin:geode` frame or the `[geode]` logger prefix (`helpers/console-noise.ts`, #624). Obsidian's
and Capacitor's own errors are dropped, so `toEqual([])` stays a Geode gate.

### 3.3 Pair (`fixtures/pair.ts`)

`launchPair({ settings?, passphrase?, serverEnv?, keepVaultA?, keepVaultB? })` returns one server,
two minted device tokens, two desktop instances and `{ A, B, server, stop }`. Most specs start here.

### 3.4 Fresh instance (`fixtures/fresh.ts`)

`launchUnconfigured(server)` launches with blank credentials so the setup wizard opens; the spec
drives the wizard DOM itself, including the server URL field.

### 3.5 Phone and hybrid (`fixtures/phone-obsidian.ts`, `hybrid-pair.ts`)

`connectPhone()` attaches to the already-installed Obsidian on the test device (`adb` selects the
device named by `ANDROID_SERIAL`; the attach goes through `adb forward` plus CDP). The harness never
creates the device vault: the interlock compares `app.vault.getName()` against `GEODE_PHONE_VAULT`
before any reset. `PhoneInstance` exposes `forceStop()` and `relaunch()` so a spec can kill the app
mid-sync.

`launchHybridPair({ phoneAsA?, passphrase?, settings?, phoneOpts?, serverEnv?, seedFromVault? })`
returns `{ A, B, server, stop }` where A and B are `SyncDevice`s (`helpers/device-abstraction.ts`),
either a desktop or the phone, so one spec body covers both roles.
`seedFromVault: { sourceDir?, count }` seeds the desktop vault from a real vault and holds the phone
back until the desktop has pushed the backlog. `device-abstraction` lets the same `waitFor*` helpers
run against a Playwright `Page` (desktop) or an eval-only device.

---

## 4. Driving the app

| Need                            | How                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read/write vault content        | `helpers/editor.ts`: `writeVaultFile` / `readVaultFile` through the vault adapter                                                                                                              |
| Mutate via the plugin's own API | `helpers/geode.ts`: `upsertVaultFile`, `commitPath`, `markLocalEdit`, `disconnectSync`, `reconnectSync`                                                                                        |
| Run a Geode command             | `helpers/palette.ts`: `runCommand(win, "Geode: Push now")`, resolved through a name to id map and executed with `app.commands.executeCommandById` (Ctrl+P does not fire on the device WebView) |
| Assert the status bar           | `helpers/waits.ts`: `waitForStatusBar`, `readGeodeStatusBar`                                                                                                                                   |
| Assert the file explorer        | `waitForFileInExplorer` / `waitForFileMissingInExplorer` (real DOM), `waitForContent`                                                                                                          |
| Wait for two devices to agree   | `waitForConvergence(A, B, path)` polls both sides' bytes                                                                                                                                       |
| Ad-hoc state read               | `await A.eval("app.plugins.plugins.geode.transport.getState()")`                                                                                                                               |
| Enter the admin token           | `helpers/admin-token.ts`: `enterAdminToken(A)` fills and continues the prompt (the fixture admin token is `e2e`, also on the phone server in loopback runs)                                     |

`eval` wraps the expression in an `AsyncFunction` that closes over the app's `app` object, so
`await` works and the value comes back as JSON.

---

## 5. Running the suite

```bash
deno task build:plugin                     # plugin-dist/ must exist first
node node_modules/@playwright/test/cli.js test --config=test/e2e/playwright.config.ts --project=default
GEODE_PHONE=1 ADB_PATH=adb ANDROID_SERIAL=<serial> \
  node node_modules/@playwright/test/cli.js test --config=test/e2e/playwright.config.ts --project=phone
```

- `playwright.config.ts` runs `workers: 1`, `fullyParallel: false`, 120 s per test, and loads
  `.env.local` when it exists (via `process.loadEnvFile`).
- `globalSetup` does nothing for a desktop-only run. With `GEODE_PHONE=1` it takes the shared
  test-phone flock for the whole run, frees the fixed phone-server port, checks the seed vault, and,
  when `GEODE_PHONE_RESET=1`, refuses to wipe a vault that is not `GEODE_PHONE_VAULT`.
- Machine-specific values come from the environment, never from the repo: `ANDROID_SERIAL`,
  `GEODE_PHONE_VAULT`, `GEODE_SERVER_URL`, `GEODE_ADMIN_TOKEN`, `GEODE_SEED_VAULT_DIR`,
  `GEODE_PHONE_RESET`, `GEODE_PHONE_PUSH`, `GEODE_PHONE_HOST`, `GEODE_PHONE_SERVER_PORT`,
  `OBSIDIAN_BIN`, `DENO_BIN`, `ADB_PATH`. `ops/dev-setup.md` §2 has the table.
- CI runs no Playwright. `ci.yml` is type-check, build, standards and `deno task test:ci`; the E2E
  layer is a local or on-device gate, which is why `step-gates.md` asks for a local E2E run.

---

## 6. Per-gate scenarios

Each scenario lives at `test/e2e/scenarios/<name>.spec.ts`; a `.phone.spec.ts` or `.hybrid.spec.ts`
suffix puts it in that project. The wording below is the assertion intent; the spec owns the exact
`expect()` calls.

### Gate 4: Plugin two-device sync

1. **`gate4-plugin-loads.spec.ts`** (+ `.phone`): the plugin loads, no Geode console errors, the
   status bar is present.
2. **`gate4-basic-sync.spec.ts`** (+ `.hybrid`): create, modify and delete converge on both sides;
   the new file appears in the receiver's real file-explorer DOM.
3. **`gate4-status-bar.spec.ts`** (+ `.phone`): the bar reads `Geode: synced · Last synced: …`,
   switches to `Geode: offline · Retry in Ns` while the server is down, and returns to synced after
   the server restarts.

### Gate 5: three-way merge

4. **`gate5-merge-non-overlapping.spec.ts`** (+ `.hybrid`): A edits line 1 while B is disconnected,
   B edits line 5; after reconnect both edits are on disk on both instances.
5. **`gate5-merge-overlapping-conflict-file.spec.ts`** (+ `.hybrid`): both edit line 2; the path
   keeps the server copy, a `(conflict …)` sibling holds the local copy, no markers.
6. **`gate5-conflict-file-in-explorer.spec.ts`** (+ `.phone`): a seeded conflict pair shows in the
   real explorer DOM and opens in the editor when clicked. One desktop instance.

### Gate 6: binary conflicts and recovery commands

7. **`gate6-resync-from-scratch.spec.ts`** (+ `.hybrid`): B runs `resyncFromScratch()`; every file
   stays byte-identical, the tracked-file count matches on both sides, no duplicates.
8. **`gate6-export-vault.spec.ts`** (+ `.phone`): the export folder contains every seeded file,
   byte-equal to the vault.

### Gate 9: polish

9. **`gate9-status-bar-transitions.spec.ts`** (+ `.phone`): locked, synced, offline, synced.
10. **`gate9-conflicts-modal.spec.ts`** (+ `.phone`): the Conflicts modal lists the seeded pair,
    Review opens the colored comparison (shared lines plain, each file's own lines in its color with
    a margin bar), Back returns to the list, "Open both" opens it, and deleting the pair empties the list.

### Gate 10: trash

11. **`gate10-trash-restore.spec.ts`** (+ `.hybrid`): delete a file, the trash lists it, restore it
    programmatically, and the file is back on both instances while the trash is empty.
    `trash-ui.spec.ts` opens the Trash modal and restores from the row's Restore button.

### Gate 11: onboarding

12. **`gate7-create-vault-wizard.spec.ts`** (+ `.phone`): unconfigured app, create-vault wizard,
    unlock, commit a note, the server reports it, no "Failed to fetch".
13. **`gate7-pair-second-device.spec.ts`** (+ `.phone`): A creates, B joins with the admin token; a
    wrong passphrase leaves B locked with an error (exercises the verifier).
14. **`gate7-brat-shape-smoke.spec.ts`** (+ `.phone`): a plugin dir with only `main.js` and
    `manifest.json` (no sidecar) unlocks and syncs, which proves the libsodium WASM is inlined.

(These three keep the `gate7-` prefix for historical reasons; they verify gate 11.)

### Levels and the rest

`level0-single-device.spec.ts` is level 0 of the campaign (see `e2e-campaign.md`). The remaining
specs cover features built after gate 11 (re-key, file history, rename chains, the mass-delete
guard, trash delete-forever, interrupts, UI surfaces), in `*.phone.spec.ts` / `*.hybrid.spec.ts`
pairs where the device matters. `test/README.md` lists them.

---

## 7. Relationship to `step-gates.md`

Each gate has an **E2E (Playwright)** subsection naming the specs that are its evidence, and its
pass criteria include those specs green in a local run. `test/README.md` fixes the naming rule:
`gateN-` only for a spec (or family) cited as gate N's evidence.

---

## 8. Dev loop

1. `deno task dev`: server in watch mode.
2. `deno task build:plugin --watch`: esbuild rebuilds `plugin-dist/` on change.
3. Point a dev vault's `.obsidian/plugins/geode/` at `plugin-dist/`, or let a spec copy it per test.
4. Reload the plugin from Obsidian itself ("Reload app without saving"); the build script does not
   talk to the running app.
5. Ad-hoc: `await A.eval("app.plugins.plugins.geode.transport.getState()")` from a scratch spec, or
   `deno task phone:cdp -- "<js>"` against the device.

---

## 9. Gotchas

- **Plugin trust prompts.** Restricted mode blocks a community plugin. The fixture writes
  `community-plugins.json` and `app.json` (`trustedAuthors` from the built manifest) before launch;
  a manifest author change would otherwise stop the plugin loading.
- **Copy, never symlink.** `install.ts` copies `plugin-dist/` and strips runtime state (`data.json`,
  `local-files.json`, `sync-cursor.json`, the legacy key cache) so a stale cache cannot auto-unlock
  the vault or pollute reconciliation.
- **Fresh vault dirs.** Obsidian rewrites `workspace.json` constantly; do not assert on workspace
  state across launches.
- **The phone is a shared resource.** Every phone or hybrid run takes the flock; a queued run waits
  and reports an ETA (`deno task phone:status`). A SIGKILLed runner releases it, because the lock
  child's stdin pipe closes with the parent.
- **The device vault is real.** `GEODE_PHONE_RESET=1` wipes it; the interlock aborts unless the open
  vault matches `GEODE_PHONE_VAULT`. Never point `GEODE_SERVER_URL` at a server you care about.
- **Two Electron apps on one machine.** Two instances plus the server need roughly 7 GB in practice
  on the dev box (observed, not enforced). Run `--project=default --workers=1` and no third
  instance.
- **Selectors.** `.cm-content`, `.workspace-leaf` and the palette classes work in current Obsidian
  builds but are not guaranteed; a spec that breaks after an Obsidian update is usually a selector,
  not a product bug.
- **Traces are for humans.** `trace: "retain-on-failure"` produces artifacts for debugging; assert
  on DOM or `eval`, never on a trace.

---

## 10. What this layer does NOT cover

- **iOS.** The `phone` project drives Android only.
- **Real-world network conditions.** Everything runs on localhost or through `adb reverse`.
- **The BRAT or community-store install path.** Specs copy the built plugin into a vault; the real
  install path is manual smoke before a release.
- **Other OS builds of Obsidian.** CI runs no E2E at all; local runs are usually Linux.
- **Caddy and TLS.** No spec fronts the server with Caddy; TLS is covered by the gate 7 manual
  checks.

---

## 11. Acceptance for this layer

- [ ] Every gate that names an E2E spec has it green in a local run.
- [ ] The `phone` project is green on a real device; `hybrid` is green with a real desktop peer.
- [ ] Failing tests leave a screenshot or trace artifact in `test-results/`.
- [ ] A Geode console error fails the spec; Obsidian's own noise never does.
