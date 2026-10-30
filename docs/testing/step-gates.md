---
covers: [test/e2e/scenarios/gate*.spec.ts]
watches: [test/scenarios/**, test/integration/**, test/unit/**, test/e2e/scenarios/**]
---

# Per-step test gates

Each gate answers "is step N done": the code it covers, the tests that pin it, manual checks, and
the pass bar. A step assumes the step before it is correct.

Acceptance checklists for the surfaces also live at the end of `../architecture/plugin.md` (§12) and
`../architecture/merge.md` (§10). Those say what to verify; this doc says how.

Test commands are in `test/README.md`. CI runs `deno task test:ci` (unit, integration and scenario
tests, without `test/fuzz`) and no Playwright, so the E2E specs named here are green in a local run;
`.phone` and `.hybrid` specs need the device.

Each gate has three parts: tests, manual checks, pass criteria.

---

## Gate 1: Server blob store + schema

**Code:** `server/db.ts`, `server/blobs.ts`, `server/blob-routes.ts`, `db/migrations/001_init.sql`.

### Tests

- `test/unit/server/migrations.test.ts`: a fresh DB applies every migration and sets
  `_meta.schema_version` to the newest number; re-running is a no-op; WAL is on; a failing migration
  rolls back and leaves no partial state.
- `test/unit/server/blobs.test.ts`: `putBlob` writes the file and returns `{ ok: true }`, rejects a
  malformed hash and a body over `MAX_BLOB_SIZE` (4 MiB), treats a second put of the same hash as a
  dedup hit (and refreshes its mtime), keeps concurrent puts of one hash to one valid file, keeps
  vaults isolated, returns null or false for a missing blob, and leaves no `.tmp-*` file after a
  successful put or a failure in the write chain. `removeStrandedTempFiles` removes a temp file a
  crash left in any vault's shard and keeps real blobs.
- `test/unit/server/routes-blob.test.ts`: `POST`, `HEAD` and `GET /blobs/:hash` with a device token
  return 200 (200/404 for HEAD), 401 without a token, 400 for a bad hash, 413 over 4 MiB, and 409
  during a re-key session.
- `test/unit/server/blob-size.test.ts`: an oversized stream or an oversized `content-length` is
  rejected without buffering the whole body.

The server does not verify `blake3(body) == hash`: the body is ciphertext and the hash is the
plaintext chunk hash. A mismatched body returns 200, not 409.

### Manual checks

All `/blobs/:hash` requests need `-H "Authorization: Bearer <device-token>"` and operate inside the
token's vault. The routes live in `server/blob-routes.ts`, not `server/routes.ts`.

- [ ] Start the server with `deno task dev` (port 8080) and run a curl round-trip:
  ```bash
  TOKEN="<device-token>"
  BODY="hello"
  HASH=$(echo -n "$BODY" | b3sum --no-names | head -c64)
  curl -i -X POST "localhost:8080/blobs/$HASH" \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary "$BODY"   # expect 200
  curl -i -X POST "localhost:8080/blobs/$HASH" \
    -H "Authorization: Bearer $TOKEN" \
    --data-binary "$BODY"   # expect 200 (idempotent, per-vault dedup)
  curl -i "localhost:8080/blobs/$HASH" \
    -H "Authorization: Bearer $TOKEN"   # expect 200 + "hello"
  ```
- [ ] Verify `data/geode.db-wal` exists after the first write.
- [ ] Kill the server mid-upload of a large blob, restart, and retry the same blob. The retry
      succeeds and the stranded `.tmp-*` file is gone: startup removes every temp file in the blob
      store before the listener starts (pinned by `test/unit/server/blobs.test.ts`, "startup removes
      every stranded .tmp-* file and keeps real blobs"). `putBlob`'s `finally` removes the temp file
      on any in-process failure, so only a crash can leave one for the next start.

### Pass criteria

- All unit tests green.
- Every manual curl step returns the expected status.
- `deno task standards` passes: every `server/` file stays under the 300-code-line tripwire
  (`scripts/check-loc.ts`).

---

## Gate 2: Shared crypto, chunking and normalization

**Code:** everything in `core/`.

### Tests

- `test/unit/core/crypto.test.ts`: `deriveKeys` is deterministic and salt-sensitive; chunk encrypt
  and decrypt round-trip; the same plaintext and key produce byte-identical ciphertext
  (deterministic nonce); a wrong key or corrupted ciphertext throws; metadata and paths are bound to
  the path hash; the three HKDF labels produce distinct keys. The file also covers `deriveAuthKey`,
  `authHashHex`, `encryptPath` and `decryptPath`.
- `test/unit/core/crypto-verifier.test.ts`: the verifier accepts the right passphrase and rejects a
  wrong one or a short blob.
- `test/unit/core/chunker.test.ts`: an empty input yields nothing; a small file yields one chunk;
  chunking is deterministic; sizes stay in `[min_size, max_size]`; an append changes only the last
  chunk; a middle insertion changes only the overlapping chunks; a 1 byte prepend keeps at least half
  of the chunk hashes on 500 KB of deterministic pseudorandom data. The test asserts locality, not
  positional equality (the cut hash carries from each chunk start), which is what fastcdc guarantees;
  `../crypto/encryption-chunking.md` §8 carries the measured rates.
- `test/unit/core/hash.test.ts`, `normalize.test.ts`, `reassemble.test.ts`: known blake3 vectors,
  keyed versus unkeyed hashes, path and line-ending normalization, BOM stripping, MIME detection,
  and reassembly that throws on a reordered or swapped chunk.
- `test/unit/core/golden-identity.test.ts`: golden vectors for path hash, identity hash, nonce and
  sealed bytes. A mismatch means an output changed and existing vaults would break.

### Manual checks

- [ ] Run `deno task test` on Windows as well as Linux. Hash outputs must match byte for byte;
      `golden-identity.test.ts` pins them. CI covers Linux only.
- [ ] Record how long one Argon2id derivation takes on the dev desktop and on a phone (the default
      parameters are libsodium `MODERATE`; `runArgon2` in `test/bench/crypto-bench-entry.ts` times
      `deriveKeys` with explicit ops and mem limits).

### Pass criteria

- All unit tests green on Linux and Windows.
- The Argon2id timings are recorded in this doc, and under 2 s on the tested phone.
- Every cryptographic primitive comes from libsodium or `@noble/hashes`; no hand-rolled
  construction.

---

## Gate 3: Server WebSocket and sync endpoints

**Code:** `server/ws.ts`, `server/ws-handshake.ts`, `server/routes.ts` (`/heads`, `/versions`),
`server/auth.ts` (token validation only; full auth is gate 7).

### Tests

- `test/unit/server/ws-hub.test.ts`: monotonic seq on insert, a stale parent is rejected with a
  conflict, two commits on one parent resolve first-wins, a stale connection close does not
  unregister a reconnected device, and paths commit independently. A commit is broadcast to every
  connection except the committing device (`server/ws.ts:271`).
- `test/unit/server/ws-queue-limit.test.ts`: a receive queue over `MAX_QUEUE_MESSAGES` (1000) or
  `MAX_QUEUE_BYTES` (8 MiB) closes with 1011; traffic under both caps stays open.
- `test/unit/server/heads.test.ts`: `GET /vaults/:id/heads` returns the latest non-deleted version
  per path; `after_seq=K` returns heads with seq above K, including tombstones; the stream is
  NDJSON, one head per line; aborting mid-stream does not leak a rejection.
- `test/unit/server/versions.test.ts`: `GET /vaults/:id/versions/:pathHash` returns the chain
  newest-first; `up_to` and `before` page a long chain without gaps; an unknown path hash returns an
  empty array, not 404.
- `test/integration/server-ws/two-clients.test.ts`: two real WebSocket clients on a real server; A's
  commit reaches B with a matching seq; a client reconnecting with `last_seen_seq=K` receives
  exactly the versions above K; simultaneous same-parent commits resolve first-wins. The folder also
  holds `commit-errors.test.ts`, `client-progress.test.ts` and `replay-backpressure.test.ts`.

### Manual checks

- [ ] `websocat ws://localhost:8080/vaults/<id>/sync -H "Sec-WebSocket-Protocol: bearer.<token>"`
      opens twice; a commit from one client arrives on the other.
- [ ] Restart the server, reconnect with a stored `last_seen_seq`, and verify the replay arrives in
      seq order.

### Pass criteria

- All unit and integration tests green.
- The two-client demo works end to end.
- No version is delivered out of seq order.
- `hello_ack` is sent before the replay, pinned by `test/unit/server/ws-ack-order.test.ts:83`
  (`server/ws-handshake.ts:75`).

---

## Gate 4: Plugin two-device sync (no merge yet)

**Code:** `plugin/main.ts`, `plugin/sync/transport.ts`, `plugin/plumbing/state.ts`,
`plugin/sync/events.ts`, `plugin/sync/reconciler.ts`, `plugin/sync/apply.ts`,
`plugin/sync/commit.ts`.

Merge logic assumes correct sync, so this gate comes before any merge work.

### Tests

All use `test/two-vault-driver.ts`:

- `test/scenarios/sync/basic-sync.test.ts`: create, modify and delete on A reach B.
- `test/scenarios/sync/initial-sync.test.ts`: B joins a vault with 5 existing files and converges;
  initial sync is followed by live updates with no duplicates and no missed updates: a new file and
  an edit of a synced one both land on B, and the server holds exactly one new version for each path
  (1 and 2).
- `test/scenarios/sync/reconnect-replay.test.ts`: B disconnects, A commits 3 times, B reconnects and
  receives all 3 in seq order; a server restart mid-session reconnects both clients from their stored
  `last_seen_seq`: no already-applied version is replayed (the write spy on B sees only the one
  post-restart edit) and the path ends with one new version, not one per reconnect.
- `test/scenarios/sync/origin-echo.test.ts`: a replayed version of A's own commit advances the
  cursor without rewriting the file.
- `test/scenarios/sync/reconciler-external-edit.test.ts`: an external create, modify and delete are
  committed; an mtime-only touch is not.
- `test/scenarios/sync/debounce.test.ts`: saves inside the pending window coalesce into one op, and
  `pushNow()` flushes immediately.
- Rename handling: `test/scenarios/sync/rename-note.test.ts`, `rename-chain.test.ts`,
  `rename-reconciler.test.ts`.

Unit tests for the same paths live in `test/unit/plugin/` (for example
`events-debounce-window.test.ts`, `reconciler-*.test.ts`, `transport-*.test.ts`).

### E2E (Playwright, real Obsidian)

- `test/e2e/scenarios/gate4-plugin-loads.spec.ts` (+ `.phone`): the plugin loads with no Geode
  console errors (`consoleErrors()` keeps only Geode-framed errors, #624) and the status bar is
  present.
- `test/e2e/scenarios/gate4-basic-sync.spec.ts` (+ `.hybrid`): two real instances converge on
  create, modify and delete; the created file appears in the receiver's real file-explorer DOM.
- `test/e2e/scenarios/gate4-status-bar.spec.ts` (+ `.phone`), while the server is up the bar starts
  with `Geode: synced`, switches to `Geode: offline` with a retry delay while the server is stopped,
  and returns to synced after the server restarts.

### Manual checks (real Obsidian, two desktop instances)

- [ ] Two test vaults, both pointing at `localhost:8080`. An edit in vault A commits at most 2 s
      after the first edit (`PENDING_WINDOW_MS`); vault B shows the change one round-trip later.
- [ ] Stop the server, edit in both vaults, restart it; both converge with no duplicates (no merge
      yet).
- [ ] Touch a file in vault A with an external editor. Trigger the reconciler. The change appears in
      vault B.
- [ ] Kill Obsidian on vault A mid-edit, before the 2 s window fires; reopen it. The autosaved bytes
      are on disk, and the reconciler re-detects and commits them. Pending ops are in memory only
      (no queue file), so the reconciler is the recovery path.
- [ ] Edit while the server is stopped; the op is queued and commits on reconnect.

### Pass criteria

- All FakeVault scenario tests pass.
- All E2E scenarios for this gate are green in a local run.
- Manual checks pass.
- A day of dogfooding on two desktops shows no data loss and no duplicate files.
- The status bar reports the states above.

---

## Gate 5: three-way merge

**Code:** `plugin/sync/merger.ts`, `plugin/sync/conflicts.ts`.

### Tests

The merge scenarios from `../architecture/merge.md` §9 live in `test/scenarios/merge/`:

- `merge-different-files.test.ts`: concurrent edits to different files both commit.
- `merge-non-overlapping.test.ts`: A edits line 1, B edits line 5; clean merge, both edits present.
- `merge-overlapping.test.ts`: both edit the same line; the path keeps the server copy, the conflict
  file keeps the local copy, no markers.
- `merge-same-line-token.test.ts`: both rewrite one word on a line; both edits are kept and never
  spliced into a third token.
- `merge-delete-vs-edit.test.ts`: A deletes, B edits; B's edit wins with no conflict file.
  `merge-delete-vs-remote-modify.test.ts` covers a stale delete that hits a conflict, and
  `merge-delete-vs-edit-recommit.test.ts` covers a server-deleted local edit returning to peers.
- `merge-both-create-same-path.test.ts`: two independent creates of one path produce a conflict file
  named `notes/new (conflict <device> <date> <time>).md` (extension preserved).
- `merge-same-content.test.ts`: identical content on both sides is a no-op.
- `merge-binary.test.ts`: two edits to one PDF or image keep the server's version and save the local
  one as a conflict file.
- `merge-three-way-pingpong.test.ts`: A, B and C edit non-overlapping lines and converge within five
  versions.
- `merge-ancestor-walk-deep.test.ts`: a deep version chain merges from the right ancestor.
- `merge-no-marker-commit.test.ts`: a merge that would produce markers becomes a conflict file, and
  no marker content is committed.

Additional merge tests in the same folder cover char-level per-hunk merging, the
merged-equals-remote case, conflict write order and a missing local row.

### E2E (Playwright, real Obsidian)

- `test/e2e/scenarios/gate5-merge-non-overlapping.spec.ts` (+ `.hybrid`): A edits line 1, B edits
  line 5 while disconnected; after reconnect both edits are on disk on both instances.
- `test/e2e/scenarios/gate5-merge-overlapping-conflict-file.spec.ts` (+ `.hybrid`): both edit line
  2; the path keeps the server copy, a `(conflict …)` sibling keeps the local copy, no markers.
- `test/e2e/scenarios/gate5-conflict-file-in-explorer.spec.ts` (+ `.phone`): a seeded conflict pair
  shows in the real explorer DOM and opens in the editor when clicked. This spec runs one desktop
  instance.

### Manual checks

- [ ] Two desktops, vault A and vault B. Edit the same line of `test.md` on both within 5 seconds.
      On both devices `test.md` holds one version and `test (conflict <device> <date> <time>).md`
      holds the other.
- [ ] The conflict file syncs to both devices.
- [ ] Delete the conflict file on one side; the deletion syncs.

### Pass criteria

- All FakeVault scenario tests green.
- All E2E scenarios for this gate green in a local run.
- The manual two-desktop conflict test produces a correctly named conflict file with both versions.
- Static check: `merger.ts` has no code path that calls `commit()` with marker-containing content.

---

## Gate 6: Binary conflicts and recovery commands

**Code:** the binary conflict path in `plugin/sync/merger.ts`, the recovery commands in
`plugin/sync/recovery.ts` (`rebuildFromScratch`, `exportDecryptedVault`), and their registrations in
`plugin/plumbing/commands.ts`.

### Tests

- `test/scenarios/recovery/binary-conflict.test.ts`: two edits to an image keep the server version
  on disk and save the local one as a conflict file.
- `test/scenarios/recovery/resync-from-scratch.test.ts`: corrupt the local state, run the rebuild,
  and every file returns on disk identical to before, with no duplicates and a re-anchored cursor.
  `resync-never-drops-unsynced-file.test.ts` and
  `test/scenarios/sync/resync-keeps-divergent-local-file.test.ts` cover the files a rebuild must
  keep.
- `test/scenarios/recovery/export-vault.test.ts`: the exported tree is byte-identical to the vault;
  `export-includes-obsidian.test.ts` covers synced `.obsidian/` files.

### E2E (Playwright, real Obsidian)

- `test/e2e/scenarios/gate6-resync-from-scratch.spec.ts` (+ `.hybrid`): B calls
  `resyncFromScratch()` in the real renderer; the tracked-file count matches on both instances and
  every file is byte-identical, with no duplicates.
- `test/e2e/scenarios/gate6-export-vault.spec.ts` (+ `.phone`): `exportDecryptedVault(dir)` writes
  every seeded file into the target folder, byte-equal to the vault.

### Manual checks

- [ ] Run "Resync from scratch" from the settings button (confirm the dialog) and from the command
      palette; the vault rebuilds with progress and no UI hang.
- [ ] Run "Export decrypted vault to folder..."; the chosen folder holds a complete plaintext copy.

### Pass criteria

- All FakeVault scenario tests green.
- All E2E scenarios for this gate green in a local run.
- Both recovery commands work end to end without errors.

---

## Gate 7: Auth, TLS, systemd

**Code:** `server/auth.ts`, `deploy/Caddyfile`, `deploy/geode.service`.

### Tests

`test/integration/auth.test.ts`:

- an HTTP request without `Authorization` returns 401;
- a valid token for the wrong vault returns 403, for the right vault 200;
- a WebSocket upgrade with a bad token closes with 1008; a valid token succeeds;
- `POST /vaults` and `POST /vaults/:id/devices` require the admin token;
- five wrong admin tokens from one IP are locked out with 429 and `Retry-After`;
- deleting a device row makes the next request 401 within the 60 s cache TTL (`server/auth.ts:5`).
  Not yet met: the TTL itself, `test/integration/auth.test.ts:485` clears the cache first.

`test/unit/server/revoke-ws.test.ts` pins that revoking a device closes its live WebSocket
immediately.

### Manual checks (on a real Linux box)

- [ ] Deploy with `deploy/deploy.sh` and the systemd unit; `systemctl status geode` shows active.
- [ ] `journalctl -u geode -f` shows structured JSON logs.
- [ ] Caddy fronts HTTPS; `curl -I https://geode.example.com/blobs/<hash>` returns 401.
- [ ] The certificate is valid.
- [ ] `kill -9` the deno process; systemd restarts it within 5 s (`RestartSec=5s`).
- [ ] Reboot the box; `systemctl is-enabled geode` shows enabled and the service comes up.
- [ ] Delete a device token via SQL; within 60 s the device starts failing requests.

### E2E (Playwright, real Obsidian)

No spec covers auth or TLS. The token and revocation behaviour is pinned by the integration and unit
tests above, and the deploy checks stay manual.

### Pass criteria

- All integration tests green.
- All manual deploy checks pass.
- A real device on the open internet can sync against the deployed server.

---

## Gate 8: Mobile

**Code:** mobile paths in `plugin/main.ts` and `plugin/sync/transport.ts`, plus the key cache in
`plugin/plumbing/vault-lock.ts` and `plugin/plumbing/key-cache.ts`.

The device layer is automated: the Playwright `phone` and `hybrid` projects drive a real Android
Obsidian over ADB and CDP (`e2e-playwright.md` §1). The manual checklist is the sanity pass before a
release.

### Tests

- `test/unit/core/key-cache.test.ts` (it tests `plugin/plumbing/key-cache.ts`): `isCacheValid`
  accepts a fresh cache, rejects null and a cache older than `unlockTimeoutHours`, and honours a
  custom timeout; `cachedToVaultKeys` round-trips the base64 keys.
- `test/unit/core/key-cache-clear.test.ts`: `saveKeyCache` and `loadKeyCache` round-trip, corrupt
  JSON is a cache miss, `clearKeyCache` clears the store entry (the plugin calls
  `app.saveLocalStorage("key-cache", null)`), a throwing clear is logged, the legacy in-vault cache
  file is removed, and `resolveCachedKeys` returns null for a missing or corrupt cache.
- Cached unlock makes no Argon2id call (count them) and, after the cache is cleared, the next unlock
  takes the slow path. `test/unit/plugin/vault-lock-cached-unlock.test.ts` drives `tryCachedKeys`
  (the cached path at `plugin/plumbing/vault-lock.ts:161-185`, called from `plugin/main.ts:540`) with
  the Argon2id primitive counted: the cached unlock derives 0 times, the cleared cache falls through
  to `unlockVault` and derives exactly once.
- The slow passphrase path is `unlockVault` (`plugin/plumbing/vault-lock.ts:49-81`); the re-key
  retry inside it is `unlockAfterRemoteRekeyFlow` (`plugin/plumbing/vault-lock.ts:93-114`).

### Manual checks (on a real phone)

- [ ] Install the plugin on Obsidian mobile (Android and/or iOS).
- [ ] First unlock: the passphrase prompt appears and derivation takes the recorded range.
- [ ] Close the app fully and reopen it: unlock is instant from the cache.
- [ ] An edit on mobile appears on desktop within a few seconds, and the reverse after the app comes
      to the foreground.
- [ ] Background the app for 60 s, then foreground it: the status bar reconnects and syncs.
- [ ] Edit in airplane mode; reconnect; the edit pushes.
- [ ] Receive a conflict from desktop; mobile shows the conflict file in the vault tree.

### Pass criteria

- All unit tests green.
- The `phone` project green on one real Android device; the `hybrid` project green with a real
  desktop peer.
- The manual checks pass on at least one device.
- Argon2id timing on the tested phone is recorded.

---

## Gate 9: Polish (no hard gate)

**Code:** `plugin/ui/*`, the settings UI, the conflict viewer.

There is no rigid gate here. The bar is the release acceptance checklist in `strategy.md` §8.

### E2E (Playwright, real Obsidian)

- `test/e2e/scenarios/gate9-status-bar-transitions.spec.ts` (+ `.phone`): the bar reads locked,
  synced, offline with the retry delay, then synced again. Those four states are the DOM pass; the
  full status mapping is swept by `test/unit/plugin/sync-status.test.ts`.
- `test/e2e/scenarios/gate9-conflicts-modal.spec.ts` (+ `.phone`): the Conflicts modal lists the
  seeded conflict pair (file name over its folder), Review shows the two versions compared with the
  names as the colour key and Back returns to the list, "Open both" opens it, and deleting the pair
  empties the list.

### Soft criteria (use judgment)

- [ ] The status bar is informative without being noisy.
- [ ] The Logs section has been used to diagnose a real issue.
- [ ] The settings UI does not expose footguns (the passphrase is masked, and so on).
- [ ] A month of personal daily use with no data loss.
- [ ] Both E2E scenarios above are green in a local run.

---

## Gate 10: Soft-delete retention (trash)

**Code:** `db/migrations/004_soft_delete.sql`, `server/trash-db.ts` (queries), `server/trash.ts`
(routes), `server/trash-erase.ts` (delete forever), `server/main.ts` (auto-purge on start),
`server/compaction.ts` (retention floor, purge in the compaction pass), and the plugin side:
`plugin/plumbing/trash-client.ts`, `plugin/ui/trash-modal.ts`, `plugin/ui/trash-settings.ts`.

The server is the single point of truth: anything it knows can be recovered from it.

### Tests

- `test/unit/server/trash.test.ts`: a delete copies the head into `trashed_heads` with its content
  version and path ciphertext; `deleteTrashedHead` removes an entry; `purgeExpiredTrash` removes old
  rows and keeps recent ones; a global purge skips rekeying and staging vaults.
- `test/unit/server/trash-routes.test.ts`: list, restore one, restore all, purge one, purge all and
  purge-expired routes; a restore attributed to the restore pseudo-device (so every real device
  applies it); purge-all returns 401 with a device token and works with the admin token; purge one
  erases a row past the retention floor with a device token, refuses a device token inside the floor
  with 403 `purge_requires_admin` and erases that row with the admin token (#677); purge-expired
  keeps recent rows and cannot go below the server retention floor; restore refuses a name that
  moved on with 409, and restore-all skips those rows.
- `test/unit/server/trash-erase.test.ts`: delete forever erases the file's own generation and keeps
  the tombstone; a reused name keeps the newer generation; a rename chain erases both names up to
  their ceilings; a live name at its cap is refused; GC reclaims the erased blobs.
- `test/scenarios/sync/trash-restore-sticks.test.ts`: A deletes, B receives the deletion, A restores
  and B receives the restored file, which is not deleted again. Delete and restore inside the
  retention window recovers the file.
- `test/scenarios/sync/trash-delete-forever.test.ts`: delete forever erases the chain, and a
  re-created old name still reaches the peer.

Auto-purge on start uses `TRASH_RETENTION_DAYS` (`server/compaction.ts:25`, `server/main.ts:48`),
not seconds.

### Manual checks

- [ ] Delete a file in vault A; open Geode settings, Trash, View. The file is listed in the trash
      modal.
- [ ] Click Restore; the file reappears on both devices.
- [ ] Delete a file, create a new file at the same path on device B and edit it, then restore the
      trashed file. The server returns 409 and the newer file's chain is untouched.
- [ ] Set `GEODE_TRASH_RETENTION_DAYS=0`, restart the server, and verify all trash rows are purged.
- [ ] Purge-all requires the admin token; a device token gets 401.

### E2E (Playwright, real Obsidian)

- `test/e2e/scenarios/gate10-trash-restore.spec.ts`: delete a file in real Obsidian, `trash.list()`
  returns the entry, restore it programmatically, and the desktop spec asserts the restored file in
  the real file-explorer DOM of both instances (`.nav-file-title[data-path=…]`, revealed in the tree)
  while the trash is empty. The `.hybrid` variant runs the same cycle against a phone peer and
  asserts convergence (`waitForContent`), not the explorer DOM.
- `test/e2e/scenarios/trash-ui.spec.ts`: the Trash modal lists the deleted file and restores it from
  the row's Restore button.
- `test/e2e/scenarios/trash-purge-admin.spec.ts`: a purge inside the server's retention floor asks
  for the admin token (`helpers/admin-token.ts`), purges with it, and purges nothing when the prompt
  is dismissed (#677).

The "name moved on" refusal (#583 §13, #596) has no E2E spec: it is server-side and pinned by
`test/unit/server/trash-routes.test.ts`.

### Pass criteria

- All unit and FakeVault scenario tests green.
- Both E2E specs green.
- Manual checks pass: delete, trash, restore and converge on both devices.
- Auto-purge removes rows older than retention on server start.
- Purge-all requires the admin token, and so does a purge inside the retention floor (#677).

---

## Gate 11: Everyday installability and onboarding

**Code:** `plugin/ui/setup-wizard.ts`, `plugin/plumbing/provisioning-client.ts`,
`plugin/sync/transport.ts`, `plugin/plumbing/scheme.ts`, `plugin/plumbing/commands.ts`,
`deploy/install.sh`.

This gate covers the first run: install the plugin (BRAT or zip), open an unconfigured vault, run
the in-plugin setup wizard to create or join a vault, and sync live, all through Obsidian's renderer
(where `fetch` is CORS-blocked and only `requestUrl` works). That path cannot run under Deno, and
the CORS bug shipped because no real-Obsidian test covered it.

### E2E (Playwright, real Obsidian)

Three specs in `test/e2e/scenarios/`, driven against a real Obsidian over CDP:

- `gate7-create-vault-wizard.spec.ts` (+ `.phone`): a fresh server and an unconfigured Obsidian;
  drive the create-vault wizard DOM (`data-testid` selectors), assert unlock, create and commit a
  note, and assert the server reports it (Node-side `GET /vaults/:id/info` and `/heads` with the
  read-back `deviceToken` and `vaultId`). No `consoleErrors` entry contains "Failed to fetch".
- `gate7-pair-second-device.spec.ts` (+ `.phone`): device A runs `createVaultFlow`; device B drives
  the join wizard DOM with the server URL and admin token, picks the vault, and enters a device name
  and passphrase; A and B end with the same `vaultId`, and A's note converges on B. A second test
  joins with a wrong passphrase and asserts the wizard surfaces an error and B stays locked.
- `gate7-brat-shape-smoke.spec.ts` (+ `.phone`): load a plugin dir containing only `main.js` and
  `manifest.json` (no sidecar), then unlock and sync. This proves the libsodium WASM is inlined
  (`plugin/_generated/libsodium-wasm-base64.ts`, built by `scripts/plugin-build.ts`).

The `gate7-` prefix is historical; these specs verify gate 11.

### Pass criteria

- All three E2E scenarios green against real Obsidian (`workers: 1`).
- The wizard accepts `ws://`, `wss://`, `http://` and `https://` server URLs, and both the socket
  and the blob/heads HTTP calls succeed (HTTP goes through the same `requestUrl`-backed `HttpFn` as
  provisioning, with the scheme reconciled by `plugin/plumbing/scheme.ts`).
- A BRAT-shape install (no sidecar) unlocks and syncs.
- No onboarding scenario logs "Failed to fetch".

---

## Cross-gate invariants

These hold at every gate. If one fails, a previous gate regressed.

- [ ] No file in `server/` exceeds 300 code lines.
- [ ] No file in `core/` or `plugin/` exceeds 500 code lines (over 300 is a review candidate).
- [ ] `deno task standards` clean (lint, plugin types, promise rules, unused exports, duplication,
      test names, docs and private-data gates, LOC tripwires).
- [ ] `deno fmt --check` clean.
      Not yet met: nothing runs it (`.github/workflows/ci.yml:173` runs `deno task standards`, which
      has no format check), and `deno fmt --check` reports 480 unformatted files of 794.
- [ ] No `TODO` or `FIXME` without an associated issue.
- [ ] No `console.log` outside `log.ts` modules.
- [ ] Every cryptographic primitive comes from libsodium or `@noble/hashes`.

---

## How to use this doc

1. Pick a step from the milestone ladder in `../architecture/overview.md`.
2. Implement until the step looks done.
3. Open the matching gate here.
4. Run the listed tests until green.
5. Walk the manual checks.
6. Record the gate as green, then move to the next step.
