---
covers: [scripts/test-timeout.ts]
watches: [test/two-vault-driver.ts, test/helpers/*, test/scenarios/**, test/integration/**, test/bench/*]
---

# Testing, observability, operations

**Depends on:** the architecture docs in `../architecture/` and the other testing docs.

---

## 1. Test taxonomy

| Layer                   | Tool                                      | What it tests                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unit**                | `deno test` (`test/unit/`)                | Per-module logic in `core/`, `server/`, `plugin/` (where mockable), plus the E2E harness and repo `scripts/`                                                                                           |
| **Integration**         | `deno test` (`test/integration/`)         | A real server process driven over HTTP and WebSocket by client-side code: auth, provisioning, trash client, WS replay                                                                                  |
| **Scenarios**           | `test/two-vault-driver.ts` (FakeVault)    | Two (or three) plugin instances plus one in-process server on an in-memory mock of Obsidian's `Vault` API                                                                                              |
| **E2E (real Obsidian)** | Playwright over CDP (`e2e-playwright.md`) | Real Obsidian (desktop Electron, the Android `phone` project, `hybrid` pairs) against a real Deno server: vault events, status-bar DOM, palette, conflict files in the real explorer, plugin lifecycle |
| **Smoke**               | manual checklist                          | Real devices before a release; the parts the `phone` project cannot automate (Gate 8)                                                                                                                  |

Unit tests for `core/` are mandatory: that code runs on every device, so a bug there reaches every
vault. The FakeVault layer carries breadth (228 tests in 85 scenario files, no browser). The
Playwright layer adds depth where the FakeVault mock is blind to real Electron behaviour; full spec
in `e2e-playwright.md`.

---

## 2. Two-vault driver (`test/two-vault-driver.ts`)

### Design

`test/two-vault-driver.ts` runs the real sync core against an in-memory vault and a real in-process
server:

- `FakeVault`: the subset of Obsidian's `Vault` and `FileManager` API the plugin uses, backed by a
  `Map` and an event list, with `PLUGIN_DATA_DIR` standing in for the plugin folder.
- `TestPlugin`: the real `StateDB`, `VaultEventHandler`, reconciler, commit/apply/merge, transport
  and sync manager, with the Obsidian host replaced by the fake. It exposes `flushPending()`,
  `pushNow()`, `reconcileNow()`, `commitDirect(path)`, `disconnect()` / `reconnect()`,
  `waitForIdle()`, `waitForCaughtUp(seq)` and `waitForConvergence(other, path)`.
- `startTestServer()`: the real server handlers on port 0 with a temp data dir; returns
  `{ url, db, dataDir, restart, stop }`. `restart()` closes the listener and the DB and boots again
  on the same port and data dir, so connected clients keep their URL: the mid-session server restart
  (`test/scenarios/sync/reconnect-replay.test.ts`). `server.db` is re-read after a restart.
- `pair()` / `triple()`: one server, one vault, two or three devices; `stop()` tears it all down.
- `restartPlugin()` / `restartWithDiskChange()`: rebuild the plugin on the same `FakeVault`, the
  in-process analogue of an app restart.

### Scenario shape

The opening of `test/scenarios/merge/merge-non-overlapping.test.ts` (abridged; the real test asserts
both edits on both sides and waits for convergence):

```ts
Deno.test({
  name: "merge-non-overlapping - A and B edit different lines → clean merge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("doc.md", base);
      await A.flushPending();
      await B.waitForVersion("doc.md");

      B.disconnect();
      A.fakeVault.write("doc.md", aContent);
      await A.flushPending();
      B.fakeVault.write("doc.md", bContent);
      B.markLocalEdit("doc.md");

      await B.reconnect(); // replays A's version, marks a conflict, merges
      await B.commitDirect("doc.md");

      await A.waitForConvergence(B, "doc.md");
      const bFinal = new TextDecoder().decode(await B.fakeVault.readBinary("doc.md"));
      assertEquals(bFinal.includes("A edited line 1"), true);
    } finally {
      await stop();
    }
  },
});
```

`sanitizeOps` and `sanitizeResources` are off because the driver owns server sockets and timers; the
test is responsible for `stop()`.

### Required scenarios for `test/scenarios/`

The merge scenarios from `../architecture/merge.md` §9, plus:

- `test/scenarios/sync/initial-sync.test.ts`: B joins an existing vault and gets its files.
- `test/scenarios/sync/reconciler-external-edit.test.ts`: modify a file on A's FakeVault disk
  without firing a vault event, then run the reconciler and verify the change syncs. The same file
  covers external delete, external create and the mtime-only touch.
- `test/scenarios/sync/reconnect-replay.test.ts`: disconnect B, A makes 3 changes, B reconnects and
  sees all 3 in seq order.
- `test/scenarios/sync/large-vault-seed.test.ts` and `large-vault-resync.test.ts`: seed a large
  vault and resync it; chunking and integrity hold.
- `test/scenarios/sync/debounce.test.ts`: A saves the same file 20 times inside one debounce window;
  the writes coalesce into one pending op, and `pushNow()` lands one version.
- `test/scenarios/sync/recreate-identical.test.ts`: A deletes a file, syncs, then recreates it with
  new content; B converges.
- `test/scenarios/sync/history-reconstruct.test.ts`: walk a version chain and rebuild an old state.

### Running

```
deno task test:ci
deno test --allow-all test/scenarios/
```

CI runs on push to `main` and on pull requests: `.github/workflows/ci.yml` runs `deno task test:ci`,
which is unit, integration and scenario tests (`test/fuzz` is excluded). It must be green before
merge.

---

## 3. Observability

### Server-side (`server/log.ts`)

JSON lines to stdout, one line per event (`ts` is an ISO string, then `level`, `msg` and the event's
fields):

```json
{"ts":"2026-10-23T09:20:12.345Z","level":"info","msg":"geode server started","port":8080,"dataDir":"/opt/geode/data"}
{"ts":"2026-10-23T09:21:04.010Z","level":"info","msg":"blob put","hash":"94c5…","vault_id":"…"}
{"ts":"2026-10-23T09:22:30.777Z","level":"warn","msg":"ws auth rejected","vault_id":"…","reason":"unknown_token"}
{"ts":"2026-10-23T09:24:01.500Z","level":"error","msg":"ws handler error","vault_id":"…","error":"…"}
```

journald captures it (`StandardOutput=journal` in the systemd unit). Query:

```
journalctl -u geode -f --output=json-pretty
journalctl -u geode -o cat --since "1 hour ago" | jq 'select(.level=="error")'
```

### Plugin-side (`plugin/plumbing/log.ts`)

A ring of the last 2000 entries, fed by the shared sink registry in `core/log.ts`. Console output is
off unless debug logging is enabled; the ring is what the Logs section renders.

```ts
log.debug|info|warn|error(msg, fields?): void   // emit
subscribeLog(fn): () => void                    // live tail for the Logs section
setDebugLogging(enabled): void                  // also mirror to the console
formatError(error): string                      // stable error text
```

Surfaced in the settings tab's **Logs** section (`plugin/ui/settings-logs-section.ts`, present only
while debug logging is on): a filter per level, a details line per entry, and a copy button for bug
reports.

### Status bar feedback loop

The status bar is the surface most users see. It shows synced with the last-sync age, catching up
with progress, the pending count, offline with the retry delay, locked, paused, a held mass delete,
and the conflict count. Transport states are in `../architecture/plugin.md` §4; the status-bar forms
are in §9.

Every transport state change logs a debug line with the previous and next state, so a report of
"stuck on 'syncing'" can be traced to the transition where it stopped.

---

## 4. Recovery operations

All are plugin commands (`plugin/plumbing/commands.ts`); the server has no recovery CLI.

### "Resync from scratch" (`rebuildFromScratch`)

The settings button asks for confirmation first; the `Geode: Resync from scratch` command starts
immediately.

1. Rebuild local state from the server: it replaces `local-files.json` and the cursor, and does not
   delete vault files.
2. Stop the sync runtime, then read every head from `/heads`.
3. Apply each head with `force` (reassemble, write to disk, populate the local row), so a file
   deleted from disk while the app was closed comes back.
4. Keep a path holding an unsynced local edit (#590); re-anchor parked out-of-scope moves from their
   closed rows (#584).
5. Prune files the server does not know. A single failed head aborts the whole resync: no pruning,
   no cursor advance, and the user retries.
6. Re-anchor the cursor at the server's latest seq and go live.

Use case: sync state is wrong and the cause is unknown. The rebuild replaces local state and file
contents from the server; unsynced local edits are kept (#590).

### "Export decrypted vault" (`exportDecryptedVault`)

1. Pick a destination folder (`Geode: Export decrypted vault to folder...` opens the modal).
2. Reassemble every head from the server into that folder as plaintext. The vault folder is not
   copied; the export works from the server's chain, which is what makes it an escape hatch when
   Geode itself misbehaves.

### "Reconcile now"

Force-triggers the reconciler. Useful when an external tool just touched the vault.

### Compaction and blob GC (server, automatic)

There is no `vacuum` CLI. `server/compaction.ts` runs per vault, off the commit path, at most once
an hour (`GEODE_COMPACT_THROTTLE_MS`): it folds version rows older than `GEODE_COMPACT_FLOOR_DAYS`
(default 30) into a compacted range, then calls `gcUnreferencedBlobs`, which deletes any blob the
remaining rows and the trash no longer reference, with a 24 h mtime grace so an in-flight upload is
never collected. Trash purging runs in the same pass.

### History restore and delete forever (plugin)

File history (`plugin/ui/history-modal.ts`, `plugin/sync/history-restore.ts`) reconstructs a past
version from the server chain and restores it as a new version. "Delete forever" in the trash erases
the file's whole rename chain (`../ops/trash-soft-delete.md` §5). Both are plugin commands, not
server CLIs.

---

## 5. Schema migration policy

### Server SQLite

- Migrations are forward-only and numbered (`001_init.sql`, `002_*.sql`, ...).
- Each migration and its version bump run in one transaction.
- `db.ts` reads `_meta.schema_version` on startup and applies any migration with a higher number, in
  order.
- Never edit a committed migration. Add a new one.
- Back up before deploying a migration to prod: `cp data/geode.db data/geode.db.bak-$(date +%s)`.

### Plugin local state

No SQLite and no migrations. `plugin/plumbing/state.ts` holds `local_files`, the sync cursor, the
pending and received seqs and the backup stamp in memory; `plugin/plumbing/state-persistence.ts`
persists them as JSON in the plugin folder (`local-files.json`, `sync-cursor.json`, plus the
activity log and rekey cursor). A torn file parses as empty and the reconciler rebuilds it, so
atomic writes are nice to have, not a correctness requirement.

### Wire protocol

- `ClientHello.protocol_version` is `PROTOCOL_VERSION` (`core/protocol.ts`, currently `5`). The
  server rejects a mismatch by sending a version-mismatch message and closing the socket, and
  refuses a plugin older than its minimum-version floor (`server/version-gate.ts`).
- Adding optional fields is safe: clients and servers ignore unknown ones.
- Removing or renaming a field means bumping `PROTOCOL_VERSION` and supporting both for one release.

---

## 6. Backup strategy

The server data dir contains `geode.db` and `blobs/`. Both are essential.

- Nightly `rsync data/ backup_target:/path/`. The contents are encrypted, so any target works (S3,
  another box, USB drive).
- For SQLite, prefer `sqlite3 geode.db ".backup backup.db"` over copying the live file; it handles
  WAL correctly. Exclude `geode.db*` from the rsync of the data dir.
- A restore must also remove the live `geode.db-wal` and `geode.db-shm` (`rsync -a --delete`), or
  SQLite replays the newer WAL over the restored database and the backup loses. Exact commands:
  [`README.md`](../../README.md) "Backup and restore".
- Test a restore quarterly.

Plugin data dirs are also recoverable by re-syncing, but a backup avoids the re-download and keeps
the local state files. Optional.

---

## 7. Dev workflow (Linux dev box to Linux server)

### Daily loop

1. Server: `deno task dev` in the repo root runs the server with `--watch`.
2. Plugin: `deno task build:plugin --watch` (alias `npm run build:plugin:watch`) bundles with
   esbuild to `./plugin-dist/`, copied (never symlinked) into each dev vault's
   `.obsidian/plugins/geode/`.
3. Open two Obsidian instances on the dev machine, each with a different test vault, both pointing
   at `ws://localhost:8080`.
4. Reload the plugin in each vault from Obsidian's command palette ("Reload app without saving") or
   restart the app; the build script does not talk to Obsidian.
5. Inspect state from the renderer console (Ctrl+Shift+I):
   `app.plugins.plugins.geode.transport.getState()`.
6. Iterate.

`e2e-playwright.md` §9 covers the same loop for the Playwright suite.

### Mobile debugging (Gate 8)

**Real Android device and CDP:** `test/e2e/fixtures/phone-obsidian.ts` (`connectPhone`) attaches
Playwright to the device's Obsidian over CDP; `deno task phone:cdp -- "<js>"` evaluates one
expression on the device and prints the result; `deno task phone:status` shows whether the phone
lock is free. Machine-specific values (`ANDROID_SERIAL`, `GEODE_PHONE_VAULT`, ...) come from
`.env.local`; see `../ops/dev-setup.md` §2.

**Desktop emulation before touching a device:** run `this.app.emulateMobile(!this.app.isMobile)` in
desktop Obsidian's DevTools console. The app then reports itself as mobile, which exercises the
mobile code paths.

**Key cache:** `app.saveLocalStorage("key-cache")`. It is per device and per vault, never in the
vault folder (DevTools, Application, Local Storage).

### `deno task` definitions in `deno.json`

The five used daily (the full list is in `deno.json`):

```json
{
  "tasks": {
    "dev": "deno run --allow-net --allow-read --allow-write=./data --allow-env --allow-ffi --watch server/main.ts",
    "test": "deno test --allow-all",
    "test:ci": "deno run -A scripts/test-timeout.ts",
    "build:plugin": "deno run -A --node-modules-dir=auto scripts/plugin-build.ts",
    "ci": "deno install && deno check server/main.ts core/*.ts && deno task build:plugin && deno task standards && deno task test:ci && deno task docs:drift"
  }
}
```

`--allow-ffi` is what lets `@db/sqlite` load; `deno task dev` without it fails at startup.

### Pre-deploy checklist

- [ ] `deno task ci` is green.
- [ ] Schema migrations applied cleanly on a copy of the prod DB.
- [ ] Backup of `data/` taken.
- [ ] systemd unit reloads cleanly (`systemctl daemon-reload && systemctl restart geode`).
- [ ] `journalctl -u geode -n 50` shows no errors after restart.
- [ ] One smoke test from each connected device: edit a file, see it sync to the other.

---

## 8. Release acceptance criteria

`deno task ci` is the mechanical part; the rest is judgment.

1. **Sync correctness**
   - [ ] All tests in `test/scenarios/` pass.
   - [ ] A dogfooding run on two devices shows no silent data loss.
   - [ ] The reconciler detects all four external-change classes (edit, create, delete, mtime
         touch).
2. **Merge correctness**
   - [ ] The `../architecture/merge.md` §7 edge-case table is covered by the `merge()` tests
         (`test/scenarios/merge/`, plus the merge unit tests in `test/unit/plugin/`).
   - [ ] No marker-containing file is ever committed (asserted in code, tested).
3. **Mobile**
   - [ ] First unlock derives keys; later opens use cached keys.
   - [ ] A background-foreground cycle reconnects and reconciles.
   - [ ] The `phone` and `hybrid` Playwright projects are green on a real device.
4. **Security**
   - [ ] The server has no code path that reads plaintext content or paths.
   - [ ] Token revocation closes the live WS immediately, and the next request with that token fails.
   - [ ] `crypto.ts` has been reviewed against the libsodium docs.
5. **Operations**
   - [ ] The server starts from scratch with no manual setup beyond creating a vault.
   - [ ] Backup and restore are tested end to end.
   - [ ] "Resync from scratch" recovers from corrupted local state.
   - [ ] "Export decrypted vault" produces a complete plaintext copy.
6. **Observability**
   - [ ] The Logs section has diagnosed at least one real failure.
   - [ ] Server logs are queryable via journalctl and jq.

When all six are checked the release is shippable; the version bump and deploy are
`deno task release` (skill `geode-release`).
