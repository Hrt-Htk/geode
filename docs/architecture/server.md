---
covers: [server/*.ts, db/migrations/*.sql, deploy/*]
---

# Server

**Depends on:** `../crypto/encryption-chunking.md`. The server imports `core/protocol.ts`,
`core/hash.ts`, `core/compact.ts`, `core/version.ts`, `core/log.ts`, and `core/crypto.ts` only for the
re-key auth hash (`authHashHex`). It never encrypts or decrypts.

The server keeps an append-only version log in SQLite and a content-addressed blob store on disk. It has
no total LOC cap; `server/` stays at or below **300 code lines per file** (CLAUDE.md rule 5).

---

## 1. Runtime & install

- **Deno** (latest stable). One process. For Windows development: `winget install DenoLand.Deno`.
- **Dependencies** are declared in `deno.json` `imports` (`jsr:` and `npm:` specifiers) with
  `nodeModulesDir: "auto"`; `deno install` writes `node_modules/`. `libsodium-wrappers-sumo` is aliased
  to its CJS build because the package's ESM entry is broken upstream. Do not revert that alias.
- **The server installs its own dependency surface, not the dev toolchain.** `deploy/install.sh` writes
  a `package.json` with the version only (the server imports it solely for `pkg.version`) and runs
  `deno install`, which then resolves the server's graph: five npm packages, and reduces the
  lockfile to it. Shipping the repo `package.json` instead makes that install resolve the dev set
  (Playwright, the Obsidian/Electron typings, eslint, jscpd, typescript) onto the server (#736).
- **SQLite** is `@db/sqlite` over FFI: the process needs `--allow-ffi`, and the system `libsqlite3` is
  found through `DENO_SQLITE_PATH`.
- Dev: `deno task dev` runs `deno run --allow-net --allow-read --allow-write=./data --allow-env
  --allow-ffi --watch server/main.ts`. Prod: the systemd unit in §10.

Flags: `--data-dir` (default `./data`), `--port` (8080), `--host` (default `0.0.0.0`), parsed by
`server/args.ts`. Any other argument is **refused** with exit 64: silently skipping one used to start
the server with no admin credential, a flag without a value with the default port. The admin token is
env-only (`GEODE_ADMIN_TOKEN`) and `--admin-token` fails with a message that names the variable, because
argv is world-readable in `/proc/<pid>/cmdline` (#680 L-4); a missing token logs a startup warning. Env
knobs: `GEODE_ADMIN_TOKEN`,
`GEODE_TRASH_RETENTION_DAYS`, `GEODE_COMPACT_FLOOR_DAYS`, `GEODE_COMPACT_THROTTLE_MS`,
`GEODE_MIN_PLUGIN_VERSION`, `GEODE_VAULT_MAX_BYTES` (a systemd drop-in, not `geode.env`, see §10),
`DENO_SQLITE_PATH`.

---

## 2. Data directory layout

```
data/
├── geode.db                    # SQLite (WAL mode)
├── geode.db-wal
├── geode.db-shm
└── blobs/
    └── <vaultId>/
        ├── 0a/
        │   └── 1f3c7b9e...     # encrypted chunk, named by hex BLAKE3 of plaintext
        └── ...
```

One data dir per server instance. A backup is an rsync of this directory. The contents are encrypted, so
they are safe to copy to untrusted storage.

---

## 3. SQLite schema

`db/migrations/` is forward-only and numbered **001 … 017**. `db.ts` applies every migration above
`_meta.schema_version`, each in its own transaction together with its version bump, so a failure rolls
back both. Never edit a committed migration; add a new one. Current shape (001 plus every additive
migration):

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'schema_version'
CREATE TABLE vaults (
  id         TEXT PRIMARY KEY,          -- UUID v4
  name       TEXT NOT NULL,
  salt       BLOB NOT NULL,             -- 16 bytes, Argon2id salt
  created_at INTEGER NOT NULL,
  verifier   TEXT,                      -- 003: write-once base64 verifier blob
  argon2_ops INTEGER, argon2_mem INTEGER,  -- 009: the vault's KDF params (authoritative)
  rekey_of   TEXT REFERENCES vaults(id),   -- 013: set on the hidden staging vault (copy mode)
  auth_hash  TEXT,                      -- 014: hash of the re-key auth key
  rekey_mode TEXT,                      -- 014: NULL | 'copy' | 'replace'
  stored_bytes INTEGER NOT NULL DEFAULT 0 -- 017: blobs + version/trash row payloads
);
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  vault_id       TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,  -- 32 bytes base64url; a revoked device gets 'revoked:<uuid>'
  last_seen_at   INTEGER DEFAULT 0,     -- 005 (010 dropped the original last_seen column)
  plugin_version TEXT DEFAULT '',       -- 006
  is_restore     INTEGER DEFAULT 0,     -- 011/016: the retired trash-restore device: hidden everywhere
  applied_seq    INTEGER                -- 012: the device's reported sync cursor
);
CREATE INDEX idx_devices_token ON devices(token);
CREATE INDEX idx_devices_vault ON devices(vault_id);

CREATE TABLE file_versions (
  vault_id        TEXT    NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path_hash       BLOB    NOT NULL,     -- keyed-BLAKE3 of the normalized path
  version         INTEGER NOT NULL,     -- monotonic per (vault, path_hash)
  seq             INTEGER NOT NULL,     -- monotonic per vault (the replay cursor)
  parent          INTEGER,              -- previous version of the same path
  enc_metadata    BLOB    NOT NULL,     -- encrypted FileMeta JSON
  chunk_hashes    TEXT    NOT NULL,     -- JSON array of plaintext chunk hashes (blob IDs, GC)
  deleted         INTEGER NOT NULL DEFAULT 0,
  device_id       TEXT    NOT NULL REFERENCES devices(id),
  created_at      INTEGER NOT NULL,
  compacted_range TEXT DEFAULT NULL,    -- 007: label on a synthetic checkpoint row
  path_ciphertext BLOB,                 -- 008: encrypted path; the server never decrypts it
  rename_mark     INTEGER NOT NULL DEFAULT 0,  -- 015: 0 ordinary, 1 marker, 2 note (#583)
  restored        INTEGER NOT NULL DEFAULT 0,  -- 016: 1 = restored from the trash (#687)
  PRIMARY KEY (vault_id, path_hash, version)
);
CREATE INDEX idx_versions_seq    ON file_versions(vault_id, seq);
CREATE INDEX idx_versions_recent ON file_versions(vault_id, path_hash, version DESC);

CREATE TABLE seq_counters (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE trashed_heads (            -- 004: one row per soft-deleted name
  path_hash TEXT PRIMARY KEY, vault_id TEXT NOT NULL, head_json TEXT NOT NULL,
  deleted_by_device TEXT NOT NULL, trashed_at INTEGER NOT NULL
);
CREATE INDEX idx_trashed_vault ON trashed_heads(vault_id);
```

`seq_counters` allocates a global `seq` atomically with the `file_versions` insert, in one transaction,
without scanning `MAX(seq)`.

`pairing_codes` (migration 002) is unused: no code reads the table. It stays because migrations are
forward-only.

`created_at` is a millisecond stamp. Every SELECT that hands a version row to a client must
`CAST(created_at AS REAL)`; the FFI driver truncates 64-bit integers to 32 bits (#464).

---

## 4. Blob store (`server/blobs.ts`)

### Filesystem layout

`blobs/<vaultId>/<first2-of-hex>/<rest-of-hex>`: blobs are scoped per vault and sharded by 2 hex chars
(256 dirs per vault).

**No cross-vault dedup.** The URL hash is the plaintext chunk hash, but the stored body is that vault's
ciphertext (each vault has its own key), so sharing blobs across vaults would gain nothing.

### API

```ts
getBlob(dataDir, vaultId, hash): Promise<Uint8Array | null>
blobExists(dataDir, vaultId, hash): Promise<boolean>     // vault-scoped only, no legacy fallback
putBlob(dataDir, vaultId, hash, body, overwrite = false): Promise<PutResult>
vaultBlobBytes(dataDir, vaultId): number
gcUnreferencedBlobs(dataDir, vaultId, retained: Set<string>, now, graceMs): Promise<number>
MAX_BLOB_SIZE = 4 * 1024 * 1024
```

`PutResult` is `{ ok: true; bytesAdded: number }` or `{ ok: false; reason }`. `bytesAdded` is the
delta the PUT made (0 on a dedup hit, negative when a re-key overwrite shrinks the blob), which the
caller adds to the vault's storage counter (§4, "Storage budget"). `vaultBlobBytes` is the blob half
of that counter: it is walked at startup, after a re-key swap and after compaction, never per
request.

`putBlob`:

1. Validates `hash` against `/^[0-9a-f]{64}$/` (path-traversal defense).
2. Rejects `body.length > MAX_BLOB_SIZE` (`too_large`).
3. Unless `overwrite` is set, a dedup hit returns `{ ok: true, bytesAdded: 0 }` after refreshing the
   mtime, so GC's grace window keeps the re-referenced blob. `NotFound` falls through to a fresh
   write. The re-key path sets `overwrite` (#557): the same plaintext hash now has a new ciphertext,
   and the bytes it replaced are subtracted from `bytesAdded`.
4. Creates the shard dir, writes `…/<rest>.tmp-<uuid8>`, fsyncs, then places it with `Deno.link`. Link
   is an exclusive create, so of two concurrent uploads of one new chunk exactly one wins and the other
   gets `AlreadyExists`, which `putBlob` reports as a dedup hit (`bytesAdded: 0`) and removes its temp
   file. `overwrite` (re-key replace) renames instead, since it must replace the file; a failed rename
   removes its temp file. This needs hard link support on the data dir, which plain ext4 or xfs as
   `deploy/` creates it has; a data dir on FAT/exFAT or an SMB/CIFS mount does not.

**`putBlob` does not verify `blake3(body) == hash`.** The stored body is ciphertext and the URL hash is
the plaintext chunk hash; the client verifies integrity during reassembly.

### Garbage collection

`gcUnreferencedBlobs` walks the vault's shard dirs and deletes every file whose hash is not in
`retained` and whose mtime is older than `graceMs` (24 h, so an in-flight upload is never collected),
returning how many it deleted. `server/compaction.ts` builds `retained` from every surviving
`chunk_hashes` row plus the trashed heads, purges expired trash first, then re-measures the vault's
storage counter (the pass both dropped rows and freed blobs), and skips the pass while a re-key
session is open. It is armed off the commit path: at most once an hour per vault, and only when a
version older than the floor exists.

### Storage budget (#679)

One vault cannot fill the disk every vault shares. `server/vault-budget.ts` holds the cap, the
counter and what a full vault still accepts; nothing else touches `vaults.stored_bytes`.

- **Cap**: `GEODE_VAULT_MAX_BYTES`, default **20 GiB**, read per call, so a change applies to the next
  request. A real personal vault is a few GB at most, so an existing deployment never hits the default
  by accident, while a device token in a loop stays bounded. Set it with a systemd drop-in
  (`sudo systemctl edit geode`), not in `/etc/geode/geode.env`: `deploy/install.sh` and
  `deploy/rotate-admin-token.sh` rewrite that file and would drop the line.
- **Counter**: `vaults.stored_bytes` (migration 017, `NOT NULL DEFAULT 0`) is everything the vault
  keeps on the server: the blob files plus the payload of its version rows (`enc_metadata`,
  `path_ciphertext`, `chunk_hashes`) and its trash rows (`head_json`). It is measured in full for every
  vault at startup (`main.ts`, before the server listens), so a check is one column read rather than a
  walk. The writers keep it from there: `POST /blobs/:hash` and the re-key blob PUT add `putBlob`'s
  `bytesAdded` (0 for a dedup hit, which is also how a concurrent upload of one new chunk settles), an
  accepted commit adds its row payload plus any trashed head it wrote, a trash restore adds the row it
  re-creates, and the counter is re-measured at the end of every compaction pass (rows and blobs both
  moved) and at the end of every re-key switch: copy mode after the blob swap (`finishBlobSwap`,
  including its startup recovery), replace mode after it rewrote every row and file in place (#680). A
  switch's re-measure that fails is logged, never thrown: the switch has committed, and answering 409
  would report a re-key that happened as a failed one.
  **Row deletions are not subtracted** (a purge, a restore clearing its trash row, a history erase):
  the next measure corrects that, so the counter can only ever read high until then. That drift is
  bounded by the row payload (kilobytes per version, nothing at all for a delete-only row, which holds
  no chunk data), and it errs toward refusing a write early rather than letting one past the cap, so a
  young vault that compaction has not reached yet is left drifting until the next startup measure
  (#680). The
  startup measure walks every vault's blob files before the server listens, which costs seconds on a
  large cold vault.
- **Refusal**: `POST /blobs/:hash` and the re-key blob PUT answer **507** before reading the body; a
  `client_commit` answers `server_error` `code: "storage_full"` and inserts nothing. Both are additive
  to the wire: an old client already treats any `server_error` as a failed commit (retry, then drop
  with a visible error), and the plugin's blob path throws on a non-2xx PUT (bounded retry, then
  drop), so no client change was needed.
- **What a full vault still accepts**: only a plain tombstone (empty `chunk_hashes`) of a path whose
  current head is live. That is the one commit that frees data, and only once GC has dropped the blobs
  it orphaned. A delete of an already-deleted path, a delete carrying chunks, a re-create and a rename
  note are all refused, and so is a trash restore (507 for `…/trash/:pathHash/restore`, a skip for
  `…/trash/restore-all`), because a restore writes a version row again. A rename therefore
  **half-applies** past the cap: its marker (a tombstone of the live old name) still lands and the
  note at the new name is refused, so the client retries the note until the vault has room. When no
  compaction or GC has run yet, the way back under the cap is to raise `GEODE_VAULT_MAX_BYTES`:
  compaction only arms past `GEODE_COMPACT_FLOOR_DAYS` and GC keeps blobs younger than 24 h.
- The check is on the stored total, so each request in flight can overshoot the cap by up to one chunk
  (`MAX_BLOB_SIZE`).
- During a **copy-mode** re-key the server holds the old blob tree and the staging tree at once, so
  its disk use can reach twice the cap. Both trees are ciphertext, readable only by a device holding
  the re-key key.
- **Accepted: the staging side of a copy-mode re-key counts its blobs but not its rows** (#680).
  `insertStagingVersion` / `insertStagingTrash` write rows without charging `stored_bytes`, so a
  `POST …/rekey/rows` batch grows the staging vault's real size past its own counter, and the blob PUT
  check (`vaultOverBudget` on the staging id) sees blobs only. The staging tree is a copy of a source
  vault whose rows are already counted and capped, so the miss is bounded by that source's row payload
  and disappears at the switch, which re-measures. Charging per inserted row would also have to
  survive a re-posted batch (`ON CONFLICT DO NOTHING`), which cannot tell a re-post from a new row.

---

## 5. HTTP routes

Auth is `Authorization: Bearer <device.token>` unless the row says admin (see §8); the two per-file
purge routes take either. The route table is
declarative in `server/routes.ts`; blob routes live in `server/blob-routes.ts` and are tried first.

| Method + path | Auth | Purpose |
| --- | --- | --- |
| `HEAD /blobs/:hash` | device | 200 if the blob exists **in the token's vault**, 404 otherwise, 400 on a malformed hash |
| `GET /blobs/:hash` | device | raw `application/octet-stream` bytes |
| `POST /blobs/:hash` | device | upload a chunk; 200 whether new or already present; 413 above 4 MB; 503 while the process-wide body budget is full (§ below); 507 once the vault is past its storage budget (§4); refused while a re-key session is open |
| `GET /version` | none | `{ version }`, the server's own version |
| `GET /vaults` | admin | list vaults |
| `POST /vaults` | admin | create a vault → `{ vault_id, salt }` |
| `GET /vaults/:vaultId/info` | admin or device | `{ salt, verifier, argon2_ops, argon2_mem }` (#560: a device needs it to unlock after a re-key); staging vaults are 404 |
| `PUT /vaults/:vaultId/verifier` | device; **+ admin while `verifier` is NULL** | write-once verifier + argon2 params (409 if already set differently) |
| `PUT /vaults/:vaultId/name` | device | rename the vault |
| `POST /vaults/:vaultId/devices` | admin | create a device → `{ device_id, token, salt, verifier, argon2_* }` |
| `GET /vaults/:vaultId/devices` | admin | list devices (revoked and `is_restore` rows excluded) |
| `DELETE /vaults/:vaultId/devices/:deviceId` | admin, or the device itself | revoke a device; 403 on an `is_restore` row |
| `PUT /vaults/:vaultId/devices/:deviceId/name` | device | rename a device (its own only); 403 on an `is_restore` row |
| `GET /vaults/:vaultId/devices/status` | device | `{ head_seq, devices: [{ id, name, last_seen_at, applied_seq }] }` for the Devices view (#433); revoked and `is_restore` devices are filtered out |
| `GET /vaults/:vaultId/heads?after_seq=N` | device | NDJSON heads, one line per path (§ below) |
| `GET /vaults/:vaultId/versions/:pathHash?up_to=V&before=V` | device | the version chain (§ below) |
| `GET /vaults/:vaultId/trash` | device | trashed names |
| `POST /vaults/:vaultId/trash/restore-all`, `…/trash/:pathHash/restore` | device | restore: the version is credited to the requesting device and marked `restored` (#687); 507 past the storage budget, or a skipped entry for restore-all |
| `DELETE /vaults/:vaultId/trash/:pathHash` | device, or admin | delete-forever for the name's own generation; a device token only past the retention floor (#677) |
| `POST /vaults/:vaultId/trash/:pathHash/purge` | device, or admin | delete-forever for a whole chain in the body (§6); a device token only past the retention floor (#677) |
| `POST /vaults/:vaultId/trash/purge-expired` | device | erase entries past retention |
| `POST /vaults/:vaultId/trash/purge-all` | admin | erase all trash |
| `GET /vaults/:vaultId/trash/:pathHash/content` | device | preview a trashed version |
| `GET /vaults/:vaultId/storage` | device | filesystem usage + this vault's blob bytes, read from the storage counter |
| `PUT /vaults/:vaultId/auth` | device; **+ admin while `auth_hash` is NULL** | register the re-key auth hash: first write needs `x-geode-admin-token`, later ones only the device token (same key 200, different key 409) |
| `* /vaults/:vaultId/rekey/*` | device / re-key auth key | re-key session endpoints (`server/rekey-routes.ts`) |

### Request body limits

Every body is read through `server/http-helpers.ts` (`readCappedBody` / `readJson`), which answers
**413** the moment `content-length` (or, for a chunked body, the streamed byte count) passes the cap.
The server never buffers an unbounded body: one authed client streaming a 400 MB body would OOM the
single process and take every vault down (#676).

| Routes | Cap | Sized by |
| --- | --- | --- |
| `POST /blobs/:hash`, `PUT …/rekey/blobs/:hash` | `MAX_BLOB_SIZE` (4 MiB) | one chunk |
| every other body route (vault/device names, verifier, purge chain, re-key auth/start/switch) | `MAX_JSON_BODY` (64 KiB) | a name, a 64-char hash, a ≤32-entry purge chain |
| `POST …/rekey/rows` | `MAX_REKEY_ROWS_BODY` (~46 MB) | 64 rows of `MAX_CHUNK_HASHES` (10 000) hashes at their escaped wire size + `MAX_ENC_METADATA_LEN`; a batch is 50 rows (`plugin/sync/rekey-run.ts`) |

An absent body on `purge-expired` and on `DELETE …/trash/:pathHash` still means "server retention" /
"no chain", not 400. These in-process caps are the only body limit: `deploy/Caddyfile` sets no
`request_body` (it needs Caddy 2.10+, which `deploy/install.sh` never upgrades an existing host to).

A cap bounds one body, not the process: `Deno.serve` has no concurrency limit, so a device token can
hold many bodies in flight at once (#680). Before its first read, each read reserves the route's cap
from `MAX_INFLIGHT_BODY_BYTES` (64 MiB) and answers **503** `{ "error": "server busy" }` with
`retry-after: 1` when the reservation would pass it. It refuses rather than queues: a queue would let
one slow upload delay every other read instead of answering it. 64 MiB holds 16 concurrent blob POSTs,
1024 concurrent JSON bodies, or one re-key rows batch plus 18 MB, and the reservation is the route cap,
not the declared `content-length`, because a client can under-declare and then stream.

Two things the number does not cover. A reservation lasts the whole read, so 16 stalled blob POSTs
answer 503 to every body read until their connections end: refusals instead of unbounded buffering. And
the budget bounds *reads*, not the process: a handler that has finished reading still holds its body
while it writes the blob or parses the JSON, so the peak is 64 MiB plus up to one body per in-flight
handler. Every plugin write retries a 503 (`plugin/plumbing/retry.ts`): five attempts at 200 ms
doubling backoff, so 3 s of waiting in the worst case, three times the `retry-after` the server sends.
Both plugin transports carry the status and the body only (`HttpResp`, `TransportHttpResponse`), so the
header itself is not read; the budget is sized to outlast it instead. The surfaces are the re-key rows
batch, the re-key blob PUT, `HttpClient.putBlob`, and every `request()` call (join, verifier, purge,
admin). A 4xx is terminal on the first attempt: a re-key that aborted inside that window would leave
`rekey_mode` set and block every blob write on that vault.

A `POST …/rekey/rows` batch is also validated field by field (`validateRekeyBatch`): every row's
`enc_metadata` and `path_ciphertext` must fit their caps, and its `chunk_hashes` must parse to an
array of at most `MAX_CHUNK_HASHES` 64-hex strings (#680 N-9). `/heads`, blob GC and compaction all
`JSON.parse` that stored column, so one unparseable row would wedge them for the whole vault.

### `GET …/heads`

Initial sync: the current head of every path, streamed as NDJSON to keep memory bounded.

```json
{ "path_hash": "hex", "version": 42, "seq": 1834, "enc_metadata": "b64",
  "chunk_hashes": ["hex"], "deleted": false, "path_ciphertext": "b64", "rename_mark": 0 }
```

`after_seq` defaults to `-1`; a value that is not an integer is **400** (`intParam`), never an
empty answer (#680 L-10). The head is the newest version per `path_hash`. A deleted head is
returned when its `seq` is greater than `after_seq` (`deleted = 0 OR seq > ?`), so the default returns
every tombstone and a replay from a cursor returns only the ones deleted since.

`/heads` omits `restored` on purpose, like `parent_version` and `device_id`: a catch-up applies a
head with no `device_id`, so the own-version skip that `restored` overrides can never fire. It also
means `/heads` never tells a restoring device its own restore is marked; replay does.

### `GET …/versions/:pathHash`

The version chain for ancestor walks (`merge.md`): newest first, at most **100** rows
(`ORDER BY version DESC LIMIT 100`), `version <= up_to` (`up_to` defaults to `+Infinity`) and
`version >= before` when `before` is non-negative. The client calls it without `before`, so there is
no pagination. `up_to` and `before` go through the same `intParam` gate as `after_seq`: not an
integer is 400 (#680 L-10).

Each row carries the full record plus the additive `restored: true` when the version came back from
the trash (#687). History reads it for the restore label; the re-key re-post carries it verbatim.

---

## 6. WebSocket protocol (`server/ws.ts`)

### Endpoint

`WS /vaults/:vaultId/sync`, bearer auth via `Sec-WebSocket-Protocol: bearer.<token>`. On a mismatched
vault or an unknown token the handshake completes and the socket is then closed 1008. Upgrading without
`{ protocol }` makes browsers report a handshake failure instead of a clean close.

### Messages

`core/protocol.ts` is the single source of truth (`PROTOCOL_VERSION = 6`). Every message carries a
`type` discriminator.

```ts
// Client → server
{ type: "client_hello", protocol_version: 6, device_id, last_seen_seq, plugin_version? }
{ type: "client_commit", vault_id, path_hash, parent_version: number, enc_metadata, chunk_hashes,
  deleted, path_ciphertext?, rename_mark? }        // rename_mark: 1 marker, 2 note, absent = 0
{ type: "client_progress", applied_seq }            // #433, best-effort, no ack

// Server → client
{ type: "server_hello_ack", vault_id, vault_name, seq, server_version, rekey?, verifier_hash? }
{ type: "server_version", vault_id, seq, path_hash, parent_version, enc_metadata, chunk_hashes,
  deleted, device_id, version, path_ciphertext?, rename_mark?, restored? }   // restored: true = a trash restore
{ type: "server_commit_ack", seq, version }
{ type: "server_conflict", vault_id, path_hash, parent_version, reason }   // reason: "parent_mismatch"
{ type: "server_error", code, message }
{ type: "server_version_mismatch", server_version, client_version }        // #625
```

`restored` is **server-set only**: `client_commit` has no such field, and a client cannot mark its
own commit as a restore.

Acks and conflicts carry **no commit id** (#359): the client's commit channel only ever settles the one
in-flight commit.

### Hub

One `VaultHub` per active `vault_id`: a `Map<deviceId, HubConnection>` (a new connection for the same
device closes the old one with 1011 `duplicate device`), a bounded per-connection receive queue, and a
5-minute idle timer that drops the hub once its last connection leaves.

### Connection flow

1. Upgrade, validate the subprotocol token, `touchDeviceLastSeen`.
2. Register the connection, wait for `client_hello`. No hello within **5 s** closes 1002.
3. Version gate (§ below), then `server_hello_ack` (`seq` is the vault's max seq, `vault_name` supports
   self-heal, `rekey` is set when a re-key session is open, `verifier_hash` lets a device notice a
   passphrase change elsewhere, #560).
4. Replay every row with `seq > last_seen_seq` in ascending order, pacing at a 1 MiB send-buffer
   high-water mark.
5. Switch to live fan-out.

### Version gate (#529, #625)

`protocol_version` must equal `PROTOCOL_VERSION`, and `plugin_version` must meet
`GEODE_MIN_PLUGIN_VERSION` (default `0.0.0`). A plain plugin/server version difference is allowed: sync
keeps running and the plugin shows an update hint from `hello_ack.server_version`.

A hard failure sends `server_version_mismatch` and then closes 1008 with a reason ending
`update required`. The plugin enters `blocked` on either signal and stops reconnecting, because a bare
close would only loop (#625). A `plugin_version` longer than 64 chars also closes 1008.

A new additive field still needs a bump when an old plugin would get the behaviour **wrong** rather
than ignore it. `restored` (#687) is one: a protocol-5 plugin skips its own versions, so it would never
bring its own restore back to disk.

### Commit handling

1. Refuse the commit while the vault has an open re-key session (`rekey_in_progress`), and refuse it
   while the vault is past its storage budget (`storage_full`, §4) unless it is a plain tombstone of
   a path whose current head is live.
2. Validate the message (`server/ws-commit.ts`): hash shapes, `parent_version` an integer ≥ 0,
   `enc_metadata` ≤ 64 KB base64, `path_ciphertext` ≤ 8 KB base64, `chunk_hashes` ≤ 10 000 valid
   hashes, `rename_mark` consistent with `deleted`. A rejection is a `server_error` with a code;
   nothing is inserted. The hash cap is what limits a single file: at the chunker's 256 KB average it
   lands at about 2.5 GB (640 MB to 10 GB across the 64 KB to 1 MB chunk range), and a larger file
   cannot be committed (#680).
3. `insertVersion` transactionally: `parent_version` must equal the current head, or the reply is
   `server_conflict` (`parent_mismatch`). Otherwise it inserts `version = head + 1` and
   `seq = next_seq++`.
4. `server_commit_ack` to the origin, `server_version` to every other connection in the hub.
5. A `deleted` commit writes a `trashed_heads` row, **unless** it is a rename marker
   (`rename_mark: 1`). A marker is a history link: it writes no trash row and clears any stale one on
   that path (#583). A non-deleted commit on a trashed name clears the row too (#465).
6. `maybeScheduleCompaction` (see §4).

### Delete forever (#582)

`POST …/trash/:pathHash/purge` takes `{ chain: [{ path_hash, up_to }, …] }`: the names the file lived
at, each with a version ceiling, from the client's history walk. `server/trash-erase.ts` erases, per
name, the rows between the generation start and the ceiling, then the trash row, in one transaction:

- **Generation start**: the newest rename marker or note below the ceiling. A marker closed the
  previous file's generation (erase starts after it); a note opened this one (erase includes it). A
  reused name therefore keeps the other file's saves. A plain tombstone is not a boundary.
- **The head row is never erased** (`to = min(up_to, head - 1)`). A name left with zero rows makes
  every later commit there a silent conflict, so every erased name keeps its tombstone or rename mark.
- **Refusals**, all-or-nothing: `unknown_path_hash`, `live_head` (409), `not_a_boundary` and
  `unknown_ceiling` (400), and a chain over 32 entries or unparseable (400).
- Markers and notes of other files are never deleted.
- `DELETE …/trash/:pathHash` still erases the trashed name's own generation for older clients;
  `purge-expired`, `purge-all` and the startup purge touch each row's own generation only. Chunk GC
  reclaims the blobs later, so nothing is deleted eagerly.

### Backpressure & limits

- **Send side**: `bufferedAmount` above 8 MiB (`MAX_BUFFERED_BYTES`) closes 1011.
- **Receive side**: the per-connection queue is bounded at 1000 messages (`MAX_QUEUE_MESSAGES`) or
  8 MiB (`MAX_QUEUE_BYTES`); overflow closes 1011. The client reconnects and replays.
- **Hello timeout**: 5 s (§Connection flow).

### Single-server constraint

WS hubs are in-process. Do not run multiple server instances behind a load balancer: clients on different
boxes would not see each other live.

---

## 7. Module map (`server/`)

| File | Responsibility |
| --- | --- |
| `main.ts` | startup: DB open, startup purge + re-key blob recovery, HTTP/WS dispatch |
| `args.ts` | argv parsing: the three flags, and a refusal (exit 64) for anything else |
| `db.ts` | open + migrate, prepared query helpers (`insertVersion`, `getHeadsAfter`, `getVersionChain`, `getReplaySince`, …) |
| `routes.ts` | vault data routes + the route table |
| `blob-routes.ts` | authenticated `HEAD`/`GET`/`POST /blobs/:hash` |
| `blobs.ts` | per-vault blob store, usage walk, GC |
| `ws.ts` | `VaultHub`: register/unregister, fan-out, commit apply, backpressure, idle drop |
| `ws-handshake.ts` | hello parse, version gate, `hello_ack`, replay pacing |
| `ws-commit.ts` | `client_commit` and re-key row boundary validation (field caps) + base64 decoding, the re-key rows body cap |
| `ws-receive.ts` | the per-connection receive queue: buffering, the overflow close, `recv()` |
| `env.ts` | `envNum`, the guarded integer env read shared by the knobs |
| `ws-types.ts` | hub types, `rowToVersion`, buffer/queue limits |
| `auth.ts` | token lookup (60 s cache), admin token compare, bearer/subprotocol parsing |
| `http-helpers.ts` | `requireDevice`, `adminGate` (ours or a dedicated header), `withCors` + the header allowlist, JSON responses, client IP, capped body/JSON readers |
| `rate-limit.ts` | admin-token failure window (5 failures / 15 min per IP) |
| `kdf-bounds.ts` | the Argon2 band a client may install (ops 1 to 10, mem 8 MiB to 1 GiB) |
| `vault-budget.ts` | the per-vault storage cap, its byte counter (`vaults.stored_bytes`: blobs + row payloads) and what a full vault still accepts |
| `provisioning.ts` | vault + device creation, vault info, write-once verifier |
| `admin-vaults.ts` | vault list, device list/revoke/rename, device status |
| `trash.ts`, `trash-db.ts`, `trash-erase.ts` | soft-delete routes, `trashed_heads` bookkeeping, generation-aware history erase |
| `rekey-routes.ts`, `rekey-auth.ts`, `rekey-store.ts` | re-key session HTTP surface, the `auth_hash` / auth-key gate, staging/in-place row and blob rewrite |
| `compaction.ts` | old-version folding, expired-trash purge, blob GC |
| `version-gate.ts` | `SERVER_VERSION`, protocol + minimum-plugin-version checks |
| `fs-usage.ts` | `statvfs` via FFI for the storage route |
| `log.ts` | JSON-line logger to stdout (journald) |

---

## 8. Auth

### Token model

- **Device tokens**: 32 random bytes, base64url. `devices.token UNIQUE`. Bearer auth for every data
  route and for the WS subprotocol.
- **Admin token**: one secret, read only from `GEODE_ADMIN_TOKEN` (#680 L-4 removed the dev flag: a
  command-line value is world-readable in `/proc/<pid>/cmdline`, and the unit feeds it from a 600
  root:root `EnvironmentFile` instead). It is required to create vaults and devices, to
  revoke another device, to purge all trash, to purge any trash row **inside** the retention floor
  (#677), and to rotate the token. It is never persisted.
- **Re-key auth key**: derived from the vault's content key (`deriveAuthKey`), sent as
  `x-geode-auth-key`. The server stores only its hash (`vaults.auth_hash`).
- **First-write gates** (`PUT /vaults/:vaultId/auth` while `auth_hash` is NULL, and
  `PUT /vaults/:vaultId/verifier` while `verifier` is NULL): both are write-once, so both also require
  the admin token in `x-geode-admin-token`. A device token alone can never claim a vault's re-key
  surface or its verifier. A *missing* header is a 403 that records no admin failure (every unlock
  re-sends the auth registration, and five recorded failures would 429 that IP's admin routes for
  15 min); a present but wrong token goes through the normal admin gate and is recorded. Once the
  column is set the admin token is no longer needed (same auth key 200, different key 409), which
  keeps every unlock's re-registration and the params backfill device-only. The `auth_hash` write logs
  at `warn` with `vault_id` and `device_id`. A vault that only ever auto-unlocked keeps
  `auth_hash = NULL`: its devices cannot rekey until one joins with the admin token (the plugin
  surfaces that as a clear error).
- **KDF band**: `PUT …/verifier` and `POST …/rekey/switch` refuse `argon2_ops` outside 1 to 10 or
  `argon2_mem` outside 8 MiB to 1 GiB with 400, so no client can hand every device an unbounded Argon2
  allocation. The band binds a *change*: re-sending the vault's own stored pair is always allowed, so a
  vault still on pre-band params (the old default 2 ops / 64 KiB) keeps syncing and can still change
  its passphrase.
- **Every client header must stay in `CORS_ALLOWED_HEADERS`** (`http-helpers.ts`):
  `authorization`, `content-type`, `x-geode-auth-key`, `x-geode-admin-token`. The mobile WebView
  fetches cross-origin (`app://obsidian.md`), so a header missing from the allowlist fails its
  preflight and the call surfaces as `TypeError: Failed to fetch`. This happens on the phone only,
  because desktop rides Electron's `requestUrl`.
- **Admin rate limit**: 5 failures per 15 min per IP. The IP is the socket peer; `X-Forwarded-For` is
  trusted only when the peer is loopback (Caddy on the same host), so a direct client cannot rotate a
  fake IP (#533). The two per-file purge routes charge a bearer that is neither the admin token nor a
  device of the vault (#677), so accepting the admin token there is not a free guessing oracle.
- **The bucket map is bounded** (#680 N-7): `MAX_TRACKED_IPS` (10 000). At the cap every expired
  bucket is dropped, then the oldest, so a client rotating IPv6 source addresses cannot grow the map
  without bound. This bounds memory, not the bypass: eviction can drop an attacker's own bucket and
  its failure count, which buys nothing when a caller holding 10 000 addresses already has 10 000
  free guesses.
- **Accepted: the limit is per socket IP, so an off-host proxy collapses every client into one
  bucket** (#680 N-7). Behind a proxy on another machine the peer is the proxy and `X-Forwarded-For`
  is not trusted, because trusting a header from a non-loopback peer lets any direct client spoof a
  fresh IP per request and dodge the limit entirely. The cost is the other direction: five bad admin
  tokens from one client over such a proxy lock every admin route for 15 min. Supported topologies are
  the ones `deploy/install.sh` produces (Caddy on the same host, loopback peer) or a direct
  LAN/Tailscale client; an off-host front proxy needs a configured trusted-proxy list, which is a
  design change rather than a hardening patch.

### Validation flow

- HTTP: parse `Authorization: Bearer …`, look the token up in `devices` (cached 60 s; a cache hit also
  re-checks that its vault row still exists, one primary-key lookup, so a deleted vault's token dies on
  its next request), resolve `device_id` and `vault_id`, reject when the route's `:vaultId` does not
  match.
- WS: parse `Sec-WebSocket-Protocol: bearer.<token>`, same lookup, close 1008 on failure.

### Revocation

`DELETE /vaults/:vaultId/devices/:deviceId` replaces the token with `revoked:<uuid>` (the column is
`NOT NULL UNIQUE`, so a sentinel instead of NULL), clears the in-process token cache, and closes that
device's live socket immediately (`disconnectDeviceIfLive`). New requests fail at once, not after the
cache TTL. A device can revoke itself through the same route.

Deleting a vault row loses its devices two ways. Through the schema the `ON DELETE CASCADE` on
`devices.vault_id` fires, but the server has no vault-delete route: a vault is removed with a manual
`sqlite3` `DELETE`, which runs with `foreign_keys` off and leaves the device rows behind (#680). Those
tokens used to stay live, and every blob route keys storage off the token's own `vault_id`, so they
could still write chunks into a directory no counter budgets. `validateToken` joins `vaults`, and a
cached lookup re-checks that row, so an orphan device token stops authenticating on its next request.

A device joins a vault with the long-lived admin token. Per-device revocation is the mitigation.

### Provisioning UX

1. SSH to the server and read the admin token (`deploy/print-admin-token.sh`).
2. The plugin's setup wizard does the rest: `POST /vaults` → `{ vault_id, salt }`, `POST …/devices` for
   this device, derive keys with the chosen params, then `PUT …/verifier` (verifier + params,
   write-once). Joining a second device repeats the device creation and derives with the vault's stored
   params.

### Threat model

- **Passphrase**: never leaves the device. With full server compromise the attacker has only opaque
  ciphertexts, plus the file-equality oracle documented in `encryption-chunking.md` §2, and can guess
  the passphrase offline (below).
- **Device token compromise.** A stolen token can read every encrypted blob and version chain (useless
  without the passphrase), commit garbage versions (these surface as merge conflicts, they do not corrupt
  anything), and purge the trash it is allowed to reach: one row via `…/trash/:pathHash/purge` (or its
  `DELETE` form) only once that row is past `GEODE_TRASH_RETENTION_DAYS`, or entries already past the
  floor via `purge-expired`. The client's `retention_days` is clamped up to the same floor (#532), so it
  can extend retention, never shorten it. Inside the floor both purge routes answer
  `403 { error: "purge_requires_admin" }` (#677); the server's own auto-purge and compaction use the
  floor too.
  It cannot read plaintext or paths, purge trash inside the retention floor without the admin token,
  replace the verifier (write-once), or erase live content (a cap that reaches a live head is refused
  with 409).
  One limit remains for a row past the floor: the server cannot prove that a chain entry belongs to the
  trashed file, because names are encrypted. A token holder can therefore name any dead generation of
  any name in the vault and have it erased, blobs included on the next GC pass. That is content gone,
  bounded by the floor.
  Revoking the device is the emergency stop, and it takes effect immediately.
- **Offline passphrase guessing (accepted, #678).** A device token reads the vault's salt and KDF params
  (`GET …/info`, needed by a device that missed a re-key) and every sealed blob and `enc_metadata`. Any
  of those ciphertexts confirms a guess: derive the key with the salt and params, try to open it, and
  the Poly1305 tag says whether the guess was right. The verifier is one more such ciphertext, so hiding
  it from device tokens would close nothing, and a per-device rate limit on `/info` would not either,
  because the guessing happens offline. Full server access gives the same oracle. The cost of each guess
  is one Argon2id derivation at the vault's params; the defence is a strong passphrase. Revoke a stolen
  device at once, and change the passphrase (re-key) if the token may have been used.
- **Admin token compromise**: the attacker can create vaults and devices. Treat it as root.
- **Accepted: `Access-Control-Allow-Origin: *` alongside `authorization` in the allowlist** (#680
  L-2). The server sets no cookie, so a browser only sends a credential on a cross-origin request when
  the requesting script adds the header, which only a client already holding the device token can do.
  `*` never authorizes a cookie-credentialed response, so there is no ambient authority for a hostile
  page to borrow. The wildcard is also what makes the phone work: its WebView fetches from
  `app://obsidian.md`, an origin a server cannot enumerate, so narrowing the header would break the
  mobile client to stop a request the attacker could already send with its own token.
- **Accepted: `GET …/storage` reports the filesystem's size and free space to any device token**
  (#680 L-9). The numbers describe the server's disk, not the vault: no path, no content, and no other
  vault's usage (`vault_used` is the caller's own vault, which the caller may already read). The token
  was minted by the admin for one device, the per-vault budget (§4) already caps what that device can
  store, and the client needs `free` to warn that the disk is nearly full and to size a copy-mode
  re-key. Withholding it would degrade both to hide a fact that does not help an attacker.
- **Accepted: no per-token rate limit on the read routes** (`/heads`, `/versions/:pathHash`, blob GET)
  (#680 N-11). A token holder can only read its own vault's ciphertext, useless without the passphrase,
  and `/versions` answers at most 100 rows for one 64-hex path hash the caller already had to know. The
  cost of hammering them is SQLite reads of that one vault plus a stream the socket's backpressure
  bounds. A limit loose enough not to refuse a legitimate first sync (a 10 000-file vault issues
  thousands of `/versions` calls in one burst) sits above what abuse needs, and one tight enough to
  matter would refuse that sync. The controls live elsewhere: the storage budget bounds writes (§4),
  provisioning needs the admin token, and revocation closes a live socket at once (§ Revocation).
- **Accepted: the device token and the plaintext path index live in `<configDir>/plugins/geode/`**
  (#680 N-10). That is where an Obsidian plugin keeps data (`pluginDataPath`): `data.json`
  (`deviceToken`, `serverUrl`, `vaultId`, `salt`, `verifier`), `local-files.json` (one row per plaintext
  path), `sync-cursor.json`, the activity log and the re-key cursor. Geode never syncs it (the plugin
  directory is never in its own sync scope, `plugin.md` §2 and §6). The exposure is a *third-party* tool that copies
  the config directory wholesale: it carries the token to another server, which still only holds
  ciphertext, plus a path list of a vault that tool is already syncing. Moving the files outside the
  vault means Obsidian's per-vault `localStorage`, which loses them on every cache clear and needs a
  migration on every device, so the README warns instead.

---

## 9. Caddy + TLS

`deploy/Caddyfile`:

```caddy
# Managed by Geode (deploy/install.sh) - edits here are overwritten on update.
geode.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:8080
	log {
		output file /var/log/caddy/geode.log
		format filter {
			wrap json
			fields {
				request>headers>Sec-Websocket-Protocol delete
				resp_headers>Sec-WebSocket-Protocol delete
			}
		}
	}
}
```

Caddy fetches and renews the certificate and proxies HTTP and WebSocket. There is deliberately no
`request_body` limit here: it needs Caddy 2.10+ and `deploy/install.sh` never upgrades an existing
host, so an older Caddy would fail to start after a reboot. The server's own caps (§5) answer 413.
`deploy/install.sh` writes a `Caddyfile.generated` from this template when `GEODE_DOMAIN` is set. The
template is in `caddy fmt` form (tab indentation), so a reload logs no format warning, and its first
line is the `# Managed by Geode` marker that says who owns the installed copy.

**Device tokens never reach the access log.** The WebSocket handshake authenticates with
`Sec-WebSocket-Protocol: bearer.<device token>` (§8), and Caddy's log redacts `Authorization` and
cookies but records every other header, so an unfiltered log hands out working device tokens. The
server echoes the subprotocol back, so the token is on **both** sides of the handshake: the
`format filter` block deletes `request>headers>Sec-Websocket-Protocol` and
`resp_headers>Sec-WebSocket-Protocol` before the `json` encoder writes: same file, same JSON, both
headers gone (#727, #733). Log field names match the logged casing exactly, and Caddy logs the request
copy as `Sec-Websocket-Protocol` and the response copy as `Sec-WebSocket-Protocol`; a field with the
wrong case deletes nothing and silently leaves the token in the log. **An existing install picks this
up** by re-running `deploy/install.sh` (#736): it regenerates `Caddyfile.generated`, installs it to
`/etc/caddy/Caddyfile` and runs `systemctl reload-or-restart caddy`. It takes that file over only when
Geode owns it: absent, first line is the marker, or identical to what the last install generated, so
a Caddyfile that also serves other sites is left alone and the `cp` line to add the Geode block is
printed instead. A log written before the update still holds tokens, so delete it, and revoke any
device whose token was in it.

---

## 10. systemd unit

`deploy/geode.service`, placeholders filled by `deploy/install.sh`:

```ini
[Unit]
Description=Geode sync server
After=network.target

[Service]
Type=simple
User=geode
WorkingDirectory=/opt/geode
EnvironmentFile=/etc/geode/geode.env
Environment=HOME=/opt/geode
Environment=DENO_DIR=/opt/geode/.deno-cache
Environment=DENO_SQLITE_PATH=@SQLITE_LIB@
ExecStart=/usr/local/bin/deno run \
    --allow-net=@HOST@:@GEODE_PORT@ \
    --allow-read=/opt/geode/data,/opt/geode/server,/opt/geode/core,/opt/geode/db,@SQLITE_DIR@ \
    --allow-write=/opt/geode/data \
    --allow-ffi \
    --allow-env=GEODE_ADMIN_TOKEN,GEODE_TRASH_RETENTION_DAYS,DENO_SQLITE_PATH,DENO_SQLITE_LOCAL,GEODE_MIN_PLUGIN_VERSION,GEODE_VAULT_MAX_BYTES \
    /opt/geode/server/main.ts --data-dir /opt/geode/data --host @HOST@ --port @GEODE_PORT@
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/opt/geode/data
ProtectKernelTunables=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelLogs=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
PrivateDevices=yes

[Install]
WantedBy=multi-user.target
```

`geode` is a `--no-create-home` user, so `HOME` and `DENO_DIR` point at writable dirs under `/opt/geode`.
`@db/sqlite` needs `--allow-ffi` and `DENO_SQLITE_PATH` (the library path differs per architecture).

**Admin token**: lives in `/etc/geode/geode.env` (mode 600, root:root), loaded via `EnvironmentFile=`.
Never put it in the unit: the unit is world-readable and its environment is exposed through
`/proc/<pid>/environ`. `deploy/install.sh` mirrors `/opt/geode/.admin-token` into it on every run, so
re-runs keep the token, and re-hardens the source file to 600 root:root after its repo-wide
`chown -R` (a re-run would otherwise hand it to the service user, which could then read the admin
token back; #680 N-8). That narrows the exposure a compromised service process has, it does not close
it: `/opt/geode` belongs to the service user, so such a process could still replace the token file and
the next install re-run would reuse what it finds there. Closing it means moving the token out of the
service user's tree (for example `/etc/geode/admin-token`) and pointing `print-admin-token.sh` and
`rotate-admin-token.sh` at it, which is a deploy change beyond N-8 and is accepted for now. It prints
only the first four characters of the token (#735), so an install log does not carry it; the whole
value comes from `deploy/print-admin-token.sh`.

**Rotating the admin token**: `sudo bash deploy/rotate-admin-token.sh` writes a new token to both files,
restarts the service, and proves the old token is refused and the new one accepted. Device tokens are
untouched.

**Other env knobs** (the storage cap in §4) do **not** go in `geode.env`: `install.sh` and
`rotate-admin-token.sh` rewrite that file and would drop them. Use `sudo systemctl edit geode` and add
`[Service]` / `Environment=GEODE_VAULT_MAX_BYTES=<bytes>`, then `sudo systemctl restart geode`.

**An existing install must update its unit first.** The template's `--allow-env` gained
`GEODE_VAULT_MAX_BYTES`, but `deploy/deploy.sh` copies code only and never regenerates
`/etc/systemd/system/geode.service`, so a unit written before the knob denies it and the cap stays at
the default. Re-run `deploy/install.sh` (it rewrites the unit and presets) or add the name to that
unit's `--allow-env` by hand. The server logs the effective cap at startup (`vault storage budget`),
which is how to confirm it took.

**Re-runs restart the service.** `install.sh` runs `systemctl enable geode` and then
`systemctl restart geode`, so a re-run replaces the running process with the code it just copied.
(`enable --now` leaves a running unit alone, so an update would not take effect.)

**Bind address**: `--host` defaults to `0.0.0.0`. `install.sh` sets `127.0.0.1` when `GEODE_DOMAIN` is
set (Caddy fronts it) and `0.0.0.0` otherwise (direct LAN or Tailscale clients), printing a warning never
to open that port to the internet. It gives no firewall commands. `--allow-net` matches the bind host. `/opt/geode/data` is chmod 700, because the SQLite DB
holds device tokens. Logs go to journald (`journalctl -u geode -f`).
