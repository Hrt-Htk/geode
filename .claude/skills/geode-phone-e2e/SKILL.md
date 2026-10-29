---
name: geode-phone-e2e
description: >
  Run Geode's phone + hybrid Playwright E2E suites against the real Android device (project-scoped
  to the Geode repo). Use when asked to run/verify phone specs, hybrid specs, connect to the
  phone over ADB, refresh the plugin on-device, or triage on-device E2E failures. Encodes the
  wireless-ADB + ANDROID_SERIAL procedure that avoids the mid-run USB de-auth trap.
---

# Geode phone + hybrid E2E runbook

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`): `set -a; . .env.local; set +a` before the commands below. This is the
executable procedure for running the on-device Playwright suites. Do NOT re-derive ADB connection
each time: follow this.

If `local.md` exists in this skill folder, read it first: it holds the maintainer's device setup.

## Fixed facts (harness)

- **ADB:** `adb` on PATH.
- **Deno:** `deno` on PATH.
- **Device:** any Android device running Obsidian mobile with the test vault, reached over **wireless
  ADB at `$ANDROID_SERIAL`** (`<ip>:5555`); tests pin the wireless serial (`scripts/phone-cli.ts`),
  which avoids the mid-run USB de-auth trap. `tcpip` mode is NOT reboot-persistent (the device is not
  rooted), so plan for a re-arm after every reboot (Step 1).
- **Phone test vault:** `$GEODE_PHONE_VAULT` (an absolute on-device path in shared storage,
  `adb push`-able). Plugin dir: `$GEODE_PHONE_VAULT/.obsidian/plugins/geode/`.
- **`GEODE_PHONE_HOST` is a FLAG, not an address you must get right.** Its *presence* switches both the
  phone-only and hybrid fixtures into **loopback mode**: the server advertises `127.0.0.1` and the port
  is `adb reverse`d, because Android 16 (targetSdk 36) Local Network Protections **block the WebView from
  LAN IPs** (#241 phone-only, #286 hybrid). Any truthy value works (e.g. `1`); a LAN address is no
  longer used to reach the server.
- **Server:** the fixture **auto-spawns** a throwaway server on port 8099 (`GEODE_PHONE_SERVER_PORT`) when
  `GEODE_PHONE_HOST` is set, advertised on `127.0.0.1`; the phone reaches it over `adb reverse` and the
  desktop reaches it directly. No manual server, never point at prod. **Do NOT expect LAN reachability**,
  Android 16 blocks it, so loopback is the only path (a phone stuck at "Geode: connecting…" means the
  reverse tunnel / loopback advertise isn't set up, not a firewall).

## Golden rules

- **Every spec failing at `connectPhone`/setup, or stuck at "Geode: connecting…", is a broken HARNESS,
  not your change**: prove with the base-branch differential (main fails too). The connectPhone
  page-race, hybrid LAN block, and screencap `maxBuffer` classes were fixed in #286.
- **Run over WIRELESS ADB, not USB.** On long/repeated runs USB de-authorizes mid-run (`unauthorized` /
  `no devices`), cascading fake connectPhone "failures". Wireless holds its auth.
- **Pin the transport** with `ANDROID_SERIAL`, exported from `.env.local`: the fixture calls `adb`
  with no `-s`, so this both selects the wireless transport and disambiguates when USB+TCP coexist.
- **Runner is `node node_modules/@playwright/test/cli.js`, NOT `npx playwright`** (npx double-loads →
  "did not expect test()").
- **Agents and E2E runs can run in parallel**, each in its own Paseo worktree (never `git worktree add`);
  phone and hybrid runs queue for the phone themselves. A Paseo worktree gets its own `node_modules`
  from setup: never link the main checkout's. Build the plugin in the worktree first so
  `GEODE_PHONE_PUSH=1` pushes that branch's bundle.
- **A "device unauthorized" / "no devices" error at `connectPhone` is an environment drop, not a test
  failure**: recover the connection and re-run the affected specs; don't triage them as bugs.

## Run queue (the shared test phone is single-user)

Several agents gate their changes on this one phone in parallel. Every phone/hybrid Playwright run
takes an **exclusive flock for the whole run** in `test/e2e/global-setup.ts` (real
`flock(2)` on `/tmp/geode-phone.lock`, the same lock shell users have used by convention), and
releases on teardown, and on `kill -9`, because the flock child's stdin pipe closes with the
runner. Desktop `--project=default` runs take no lock.

**FIFO order (#508):** a run registers a ticket under `/tmp/geode-phone.queue/` and only takes the
flock when its ticket is at the head (dead-pid tickets are pruned), so concurrent runs are served in
arrival order, not flock's unspecified wake order. While queued it logs every minute
`queued for the phone: position 2, holder <worktree> (<project>, 14/21 specs, ~3 min left)`: the
holder's progress (project + specs done/total) is published to the lock sidecar by a tiny Playwright
reporter, so waiters and `deno task phone:status` show a live ETA. `deno task phone:status` prints
the holder (worktree, pid, project, d/t, elapsed, ETA) plus the queue (position, worktree, since).

**Never sleep-poll for the phone.** A phone/hybrid run queues itself; launch it (in the background if
there's other work), do the remaining work, then wait once on the process and read its log: don't
`sleep 90/240` loops.

Never call `adb` directly on the shared phone: every access goes through the locked wrappers:

- `deno task phone -- <adb args>`: run adb under the lock (default serial `$ANDROID_SERIAL`, pin
  another by overriding it).
- `deno task phone:cdp -- "<js>"`: evaluate JS in the Obsidian WebView under the lock (finds +
  forwards the devtools socket itself, cleans up after).
- `deno task phone:status`: print the current holder (worktree, pid, project, d/t, elapsed, ETA)
  plus the queue (position, worktree, since).

Shell users may still `flock /tmp/geode-phone.lock -c '...'`: they share the same lock
with real flock semantics, so both exclude each other. Runs queue themselves; wrapping a run in a
shell `flock` is also fine: setup detects an ancestor holding the lock (or `GEODE_PHONE_LOCK_HELD=1`)
and skips the re-acquire instead of deadlocking on its own ancestor (#500).

**The test-vault interlock lives in that setup**: with `GEODE_PHONE_RESET=1` the run refuses to reset
any vault whose name is not the basename of `$GEODE_PHONE_VAULT` (var unset → the run fails), so the
test phone can never reset a personal vault.

## Step 1: establish a stable wireless connection

The device must be exposing adbd over wireless at `$ANDROID_SERIAL`. Arm that once on the device's
other transport (usually USB, `adb -s "$GEODE_PHONE_USB_SERIAL" tcpip 5555`), then connect over wifi:

```bash
WS=$ANDROID_SERIAL                              # <ip>:5555
adb connect $WS
adb devices -l                                   # expect: $WS  device ...
adb -s $WS shell svc power stayon true                   # no screen-lock de-auth (idempotent)
adb -s $WS shell settings put global wifi_sleep_policy 2 # wifi never sleeps
```

If `adb connect` fails (`unable to connect` / device shows `offline`) the device likely rebooted and
dropped `tcpip` mode (it is NOT reboot-persistent). Re-arm adbd on the other transport, then
reconnect:

```bash
adb -s "$GEODE_PHONE_USB_SERIAL" tcpip 5555                   # re-arm adbd, once per reboot
adb connect $WS
```

Use `$WS` (`$ANDROID_SERIAL`) as the serial for all subsequent adb commands, and set
`ANDROID_SERIAL=$WS` for the Playwright run: the fixture calls `adb` with no `-s`, so this pins the
transport and disambiguates from the USB transport.

## Step 2: fresh Obsidian (fresh WASM heap)

Each `connectPhone` reloads the plugin; over a long session the WebView's WASM heap can OOM
(`RangeError ... Out of memory`). Force a clean restart before a run:

```bash
adb -s $WS shell am force-stop md.obsidian
adb -s $WS shell monkey -p md.obsidian -c android.intent.category.LAUNCHER 1
# wait for a fresh DevTools socket:
for i in $(seq 1 20); do
  s=$(adb -s $WS shell "cat /proc/net/unix" | grep -o 'webview_devtools_remote_[0-9]*' | head -1)
  [ -n "$s" ] && { echo "socket up: $s"; break; }; sleep 1
done
```

## Step 3: refresh the plugin on-device (ONLY if plugin/ or core/ changed)

**With `GEODE_PHONE_PUSH=1`, `connectPhone` auto-imports**: build first, then it pushes `plugin-dist`
+ restarts Obsidian, once per run. The manual steps below are the out-of-fixture fallback.

Skip this for test-only changes (the bundle is unchanged): **but keep the on-device build current.**
The server gates a plugin on wire protocol + minimum version only (#529); a plain version difference
is allowed and shows an update hint, not a block. The real failure mode is a **stale on-device build**
against an **old** server: that server still sends `server_version_mismatch` → transport `blocked` →
status bar `error`, failing *every* sync spec at "reach synced baseline". Rebuild + push (below) even
for a test-only change if `manifest.json` on the device ≠ repo version. Otherwise:

```bash
deno task build:plugin                            # from the repo root
DEST="$GEODE_PHONE_VAULT/.obsidian/plugins/geode"
for f in main.js manifest.json styles.css versions.json; do
  adb -s $WS push "plugin-dist/$f" "$DEST/$f"
done
# then re-do Step 2 (force-stop + relaunch) so the new main.js loads.
```

## Hybrid cold-sync seeding

To give the phone a real backlog to cold-sync, **seed via the real desktop client, never a headless
synthetic seeder**: a synthetic seeder commits version metadata but its blobs aren't applyable, so the
phone receives every version and writes 0 files. Use `launchHybridPair({ seedFromVault: { count,
sourceDir? } })`: it pre-populates the desktop vault with `count` real `.md` files (source via
`$GEODE_SEED_VAULT_DIR`, required for hybrid runs: there is no default and global setup fails fast
before the first test when it is missing, point it at a real vault **in place**: the fixture only
READS the source (it copies files into the throwaway test vault), so no second copy is needed), the
desktop reconciler uploads the blobs, and the
phone is gated behind desktop push-completion before it connects. Seed enough files that the drain
**outlasts connectPhone setup**: a small backlog finishes during the handshake and the transient state
(e.g. "applying") is missed. Real files apply at ~1/sec on-device (#328), so size `count` accordingly.

## Step 4: run the suite

From the repo root. `--project=phone` or `--project=hybrid`. Append space-separated spec filename
fragments to run a subset (substring match); omit to run all.

```bash
# port 8099: global setup frees a leftover Geode E2E server itself (finds the
# listening pid, verifies /proc/<pid>/cmdline is server/main.ts + geode-e2e-server-
# data dir, kills it): a NON-Geode holder fails the run; free it manually then.
ANDROID_SERIAL=$WS GEODE_PHONE=1 GEODE_PHONE_RESET=1 GEODE_PHONE_PUSH=1 \
GEODE_PHONE_HOST=1 GEODE_PHONE_SERVER_PORT=8099 \
node node_modules/@playwright/test/cli.js test \
  --config=test/e2e/playwright.config.ts --project=phone \
  > tmp/e2e-phone.log 2>&1; echo "EXIT: $?" >> tmp/e2e-phone.log
```

Hybrid launches desktop Electron too, so it needs a display and `$GEODE_SEED_VAULT_DIR` (exported
from `.env.local`); each missing piece fails the whole suite in seconds:

```bash
ANDROID_SERIAL=$WS GEODE_PHONE=1 GEODE_PHONE_RESET=1 GEODE_PHONE_PUSH=1 \
GEODE_PHONE_HOST=1 GEODE_PHONE_SERVER_PORT=8099 \
xvfb-run -a node node_modules/@playwright/test/cli.js test \
  --config=test/e2e/playwright.config.ts --project=hybrid \
  > tmp/e2e-hybrid.log 2>&1; echo "EXIT: $?" >> tmp/e2e-hybrid.log
```

Run it in the background and watch results with a Monitor that also greps for
`unauthorized|no devices|Out of memory|Stream closed` so a mid-run drop is caught early, not mistaken
for a slow test. Hybrid takes about 4 to 5 min for 21 tests. The lock is taken automatically by the
global setup: no manual `flock` around the run.

## Expected green baseline (Obsidian mobile 1.13.4)

Phone **29 active pass + 2 skip** (gate6-export-vault, gate7-brat-shape-smoke = desktop-only).
Hybrid **21/21 pass** both directions. Full phone run ~5 min all-green.

> Obsidian mobile 1.13.4 runs persistent navbar/drawer CSS animations that hang `page.screenshot()`
> and Playwright actionability, and Escape stopped closing modals. All phone specs route UI through
> `test/e2e/helpers/mobile-ui.ts` (`evalClick`/`evalSetValue`/`dismissModals`) + adb `obsidian.screenshot()`.
> `dismissModals` closes ALL `.modal-container`s: never call it while a settings tab must stay open.

> **Any deviation from this baseline is a real regression.** Specs that wait for settle (not for a
> fixed delay) are the reason the count holds.

## Writing / fixing phone specs: mobile WebView patterns

These are HARNESS realities on Android Obsidian, not product bugs. Follow them in specs:

- **Submit the passphrase modal via `[data-testid="geode-passphrase-submit"]`.click(), NOT
  `.press("Enter")`**: CDP-synthesized Enter doesn't fire the modal's `keyup` handler on Android
  password inputs.
- **Open the settings tab WITHOUT a leading `app.setting.close()`**: it prevents the settings-tab DOM
  from rendering on mobile. Use `app.setting.open(); app.setting.openTabById(app.plugins.plugins.geode.manifest.id)`
  then wait for the element (see settings-refresh).
- **The desktop status bar is not visible/clickable on mobile**: trigger its handler with an in-page
  eval click: `obsidian.eval("document.querySelector('[data-testid=geode-statusbar]').click(); return true;")`,
  not a Playwright `.click()`.
- Prefer in-page `eval(document.querySelector(...))` reads over Playwright locators for settings DOM.
- Assert modal dismissal with `.not.toBeVisible()`, not `toBeHidden()`.
- **`consoleErrors()` is a Geode-only gate** (#624): the fixtures drop every error whose text and
  stack lack a `plugin:geode` frame or the `[geode]` logger prefix (`test/e2e/helpers/console-noise.ts`),
  so Capacitor/Obsidian noise (`File does not exist at win.androidBridge.onmessage`,
  `Failed to index …`) cannot fail a spec. Never add a message allowlist to a spec: if a spec still
  flakes on a non-Geode error, the filter is the fix.
- Run commands via `app.commands.executeCommandById` (Control+P doesn't fire on the mobile WebView).

## Tablets

Same suites, same env; `ANDROID_SERIAL` is the tablet's own wireless serial. A big-screen device is
`is-tablet` and only the layout differs:

- **No `.view-actions.mod-raised`.** Obsidian sets `mod-raised` on view-header actions only on phones,
  so the mobile status shim must inject into **any visible `.view-actions`**, not only `.mod-raised`
  (#309, `plugin/ui/statusbar.ts` + `plugin/ui/view-actions.ts`). Specs asserting on the shim's
  container must match `.view-actions`.
- **Empty-state taps land elsewhere.** The mobile-navbar "+" and the empty-state "Create new note" tap
  targets move with screen size; coordinate-tap helpers must fall back to programmatic new-leaf
  creation on a tablet (`test/e2e/scenarios/statusbar-icon-multileaf.phone.spec.ts`).
- **Latency is not a bug.** A tablet reached over a VPN (~800 ms RTT) times out multi-round-trip specs
  and logs transient `401`s on that peer. Prove it is latency by running the same spec on a device on
  the local network; classify it as environment, not a regression.
- **`svc power stayon` holds the screen only while charging**, so keep a device on power for a long
  run or it dozes and drops the transport.

## On-device plugin-state probe (CDP)

To read Geode's live state/logs on a real device *without* a full E2E (root-causing a stuck sync,
confirming which vault is open, watching the plugin resume), eval JS in the Obsidian WebView over
CDP. The locked wrapper is `deno task phone:cdp -- "<js>"` (takes the phone lock, finds + forwards
the socket, cleans up):

```bash
WS=$ANDROID_SERIAL                                       # any test device, incl. a tablet
deno task phone:cdp -- "JSON.stringify({vault: app.vault.getName()})"
```

Standalone fallback (self-contained, no lock): `node .claude/skills/geode-phone-e2e/cdp-eval.mjs`,
which forwards the socket first, then passes the port + expression. `cdp-eval.mjs` shares its logic with
`test/e2e/phone-cdp.ts`.

- **Gotcha:** in `/json/list` the page target's `id` field appears **before** `type`, so a naive
  `grep -A2 '"type":"page"'` misses it: parse the JSON (the helper does). Also skip `type:"worker"`
  targets; pick the `type:"page"` whose `url` isn't `devtools://`.
- **No process → nothing to probe.** If Obsidian isn't running (no `webview_devtools_remote_*` socket),
  launch it first: `adb -s $WS shell monkey -p md.obsidian -c android.intent.category.LAUNCHER 1`.
  The in-memory ring-buffer log (`getRecentLog`) only exists while the vault is open; disk state
  survives (see "Diagnosing stuck / partial sync" below).
- **Key evals:** `app.vault.getName()` (interlock: confirm it's the test vault, not a personal one
  before any RESET) · `!!app.plugins.plugins.geode` (loaded?) · `[...app.plugins.enabledPlugins]`
  (geode absent ⇒ disabled/crash-guarded) · `app.plugins.plugins.geode.transport?.lastSeenSeq` ·
  `app.plugins.enablePlugin('geode')` (re-enable). `getRecentLog` is a module export, not on the
  plugin object: capture `Runtime.consoleAPICalled` / `exceptionThrown` events for live errors.
- **Apply-progress diagnosis: probe state, not `getFiles()`.** `app.vault.getFiles()` lags adapter
  writes on mobile (under-reports). To tell "received but not applied" from cache lag, read
  `app.plugins.plugins.geode.state.getAllLocalFiles().size` + `app.vault.adapter.list('')` +
  `transport.lastSeenSeq`: seq at target with stateRows/disk 0 ⇒ apply is failing, not lagging. Assert
  on state/adapter counts, never `getFiles()`.

## Diagnosing stuck / partial sync: server truth vs device state

When a device "won't finish syncing" or is "missing notes", compare the **server's truth** against the
**device's persisted state**. Never guess from the status bar.

**Server side** (`$GEODE_SSH_HOST`, DB path and service name from the deploy unit):

```bash
ssh "$GEODE_SSH_HOST" "sudo sqlite3 -header -column <db> \
  \"SELECT COUNT(*) versions, MAX(seq) maxseq FROM file_versions WHERE vault_id='<vid>';\""
# live file count (distinct heads, not deleted):
ssh "$GEODE_SSH_HOST" "sudo sqlite3 <db> \
  \"SELECT COUNT(*) FROM (SELECT path_hash,deleted,ROW_NUMBER() OVER (PARTITION BY path_hash ORDER BY seq DESC) rn \
    FROM file_versions WHERE vault_id='<vid>') WHERE rn=1 AND deleted=0;\""
# devices (leave = soft-revoke: token 'revoked:%', row kept for FK attribution):
ssh "$GEODE_SSH_HOST" "sudo sqlite3 -header -column <db> \
  \"SELECT substr(id,-6) dev,name,plugin_version pv FROM devices WHERE vault_id='<vid>';\""
# live events: the client's blob download storm drowns everything, so strip it:
ssh "$GEODE_SSH_HOST" "sudo journalctl -u <service> --since '6 hours ago' --no-pager | grep -v 'blob get'"
```

A steady one-at-a-time `blob get` stream (~1/s) is a device grinding a cold join; a `ws hello` with
`last_seen_seq:0` then `ws replay done count:<all>` is a fresh device replaying the whole log.

**Device side** (on-disk state survives even when Obsidian is closed or the plugin is disabled):

```bash
G="$GEODE_PHONE_VAULT/.obsidian/plugins/geode"
adb -s $WS shell "cat '$G/sync-cursor.json'"   # last_seen_seq
adb -s $WS shell "cat '$G/data.json'"           # vaultId, deviceId, verifier
```

- **`sync-cursor.json` `last_seen_seq` ≪ server `maxseq`** ⇒ apply is stalled/slow, not "missing",
  the device hasn't caught up (large-vault cold-join was fixed in #313; pre-0.18.0 builds crawl
  ~1 seq/min and get crash-guard-disabled on reboot).
- **geode absent from `community-plugins.json`** ⇒ the plugin is disabled (user, or Obsidian's mobile
  crash-guard after a kill mid-startup): sync stops dead wherever the cursor was.
- Cross-check `local-files.json` entry count against the server's live-file count to see how far it got.

**Root cause worth remembering:** a `data.json` **without `verifier`** makes
`unlockVault()` accept *any* passphrase and derive garbage keys: the WebSocket connects, the whole log
replays, and 0 files are written, silently (the per-version error path swallowed the exception). Probe:
`sm.keys.content_key?.byteLength` (expect 32), `sm.versionCache.size`, local-file count, then force
`await sm.handleVersion(firstVer)` to surface the real error. Always seed `verifier` in `data.json`.

## Triage discipline

- Classify each failure: **product-bug** (plugin misbehaves: fix `plugin/`, file an issue) vs
  **harness-limit** (mobile WebView / test drives it wrong: fix the spec or `test.skip` with a reason +
  issue link) vs **environment** (ADB drop / server unreachable: fix and re-run).
- **State leaked from an earlier spec** (a server left on 8099, an open modal, a persisted setting such
  as `syncObsidianConfig`, old log lines) looks like a regression. Every spec that starts a server or
  changes settings restores them in `finally`; prove a new failure with the base-branch differential
  below before blaming the branch.
- Verify the actual DOM with a throwaway `*.phone.spec.ts` probe (dump via `obsidian.eval` + write to a
  `tmp/` file) before deciding fix-vs-quarantine on an unclear failure. Delete the probe after.

### Base-branch differential: "my regression, or pre-existing?" (do this before triaging a fail)

A spec failing on your branch is NOT proof your change broke it. Prove causation by rebuilding the
**base commit** and running the SAME spec on-device:

```bash
git stash || true                       # branch must be committed/clean
git checkout <base-sha>                 # e.g. the merge-base, or the phase tip below your change
deno task build:plugin
# push + restart (Step 3 + Step 2), then run just the suspect spec(s) --project=phone
git checkout <your-branch>              # then rebuild+push to restore the device to your build
```

- **Fails on base too → pre-existing** (flaky/outdated spec or environment): NOT your regression;
  quarantine or fix the spec separately, don't block your change (a flaky spec cleared this way
  stays clear because the wait-for-settle fix is in the spec).
- **Passes on base, fails on your branch → real regression**: bisect by phase/commit if the branch
  stacks several. (This is how the atomic-write mobile regression was pinned to a single commit even
  though unit + desktop + benchmark were all green.)
- Corollary: **run a suspicious spec in ISOLATION** first: a full-suite fail can be load-induced
  (2-device specs on one device time out under contention); if it passes alone, it was contention, not
  a bug. Only escalate to the base differential if it fails isolated too.
- After any base-branch excursion, **rebuild + push your branch** so the device isn't left on the old
  build for the next run.
