---
covers: [server/trash*.ts, db/migrations/004_soft_delete.sql, plugin/ui/trash-*.ts, plugin/plumbing/trash-client.ts, plugin/sync/history-fetch.ts]
---

# Soft-delete retention (trash)

Routes and schema: `docs/architecture/server.md`. Settings and UI: `docs/architecture/plugin.md`.
Encryption: `docs/crypto/encryption-chunking.md`.

A deletion propagates to every connected device at once. Once every device has deleted the file, the
path to content mapping is gone: the encrypted chunks are still on disk, but nothing points at them.
Trash keeps the deleted head record on the server so a deletion can be undone.

## 1. The table

`db/migrations/004_soft_delete.sql`:

```sql
CREATE TABLE trashed_heads (
    path_hash TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    head_json TEXT NOT NULL,           -- full head record as JSON
    deleted_by_device TEXT NOT NULL,   -- device_id that initiated the deletion
    trashed_at INTEGER NOT NULL        -- epoch seconds
);

CREATE INDEX idx_trashed_vault ON trashed_heads(vault_id);
```

## 2. Server behavior

| Without trash | With trash |
| --- | --- |
| `deleted: true` commit marks the head deleted and broadcasts | `deleted: true` commit copies the head into `trashed_heads`, then broadcasts the deletion |
| The head record is gone | The head survives on the server |
| No recovery path | `POST /vaults/:id/trash/:path_hash/restore` puts it back |

The deletion still propagates as before, so there is no protocol change. The server keeps a copy, and a
restore re-syncs the file to every device.

**A rename marker is not a deletion (#583).** A `deleted` commit carrying `rename_mark: 1` closes a
rename. It writes no `trashed_heads` row and it clears a stale row left by an earlier tombstone on that
path, so the trash list, restore-all and every purge path ignore renames. The compaction plan keeps
every row with a rename mark (`core/compact.ts`), so a renamed file's history stays reachable past the
trash retention window.

Restore refuses with `409` (and restore-all counts the entry `skipped`) when the name has moved on:
either a version above the trashed head holds content again (a rename note, or a newer file created and
edited after it), or a rename marker closed the name. An older file's content never overwrites the new
file's chain, and a renamed-away name is never resurrected (#596). A plain delete followed by a restore
is unaffected, because every version after a tombstone is itself a plain tombstone.
`test/unit/server/trash-routes.test.ts` covers these refusals.

**Live content clears the trash row (#465).** A `deleted: false` commit means the name is not deleted,
so the server clears its `trashed_heads` row. The trash never lists a file that exists, and a restore
cannot race its own stale row. Delete forever (#582) is affected: a generation that lost its row this
way (a reused name, or a rename note landing on a trashed name) is reachable only through the live
name's History, which walks the whole chain. The client therefore sends the `path_hash` list it walked;
nothing server-side can find the older generation from the trash.

**An offline delete over a marker trashes nothing (#596).** A device that cannot see the marker
(offline, or a 5xx on the head fetch) may send a plain `deleted` commit at the marker's head. The
tombstone is accepted, because the name is closed either way, but the head it closes is a rename, so it
creates no trash row. A leftover row would be unrestorable too, since a marker above it means a rename.
Renamed-away names never appear in the trash and never come back through it. Delete forever must send
the chain's `path_hash` list, because the server cannot walk it: names are encrypted.

## 3. Endpoints

| Method | Path | Auth | Action |
| --- | --- | --- | --- |
| `GET` | `/vaults/:id/trash` | device token | List trashed files: `path_hash`, `version` (the trashed head's version, the ceiling of its History action, #583), `trashed_at`, `deleted_by_device`, `path_ciphertext` (base64, decrypted by the client), `enc_metadata`, `head_json` |
| `POST` | `/vaults/:id/trash/:path_hash/restore` | device token | Restore one file |
| `POST` | `/vaults/:id/trash/restore-all` | device token | Restore every trashed file; entries that fail the moved-on check are counted in `skipped` |
| `POST` | `/vaults/:id/trash/:path_hash/purge` | device token past the floor, or admin token | Delete forever (#582): the file's whole history. Body `{ chain: [{ path_hash, up_to }, ...] }`, the names it lived at with the version ceiling of each generation, as read by the client's History walk and capped at the trashed row. Erases those generations and the trash row. Inside the retention floor a device token gets `403 { error: "purge_requires_admin" }` (#677) |
| `DELETE` | `/vaults/:id/trash/:path_hash` | device token past the floor, or admin token | Purge the trashed name's own generation and its trash row. Kept for an old client, which sends no chain. Same floor gate |
| `GET` | `/vaults/:id/trash/:path_hash/content` | device token | The trashed head's encrypted content record (`chunk_hashes`, `enc_metadata`), so the client can show a size and type and open a preview |
| `POST` | `/vaults/:id/trash/purge-expired` | device token | Purge entries older than `max(requested, server floor)`. Body `{ retention_days }`; the server clamps it up to `GEODE_TRASH_RETENTION_DAYS` (default 30), so a client value can extend retention and never shorten it (#532) |
| `POST` | `/vaults/:id/trash/purge-all` | admin token | Purge all trash for the vault |

### 3a. A restore is credited to the device that asked for it (#687)

The restored version is inserted against the **requesting device**, with `restored = 1` on the row
(`db/migrations/016_restored_versions.sql`) and the additive `restored: true` on the version message
and `VersionRecord`. There is no pseudo device: the earlier design invented a per-vault
`geode-trash-restore` row because a device never writes its own versions to disk, and it leaked into
the Devices list and into history.

The plugin's apply rule is what replaces it: a device skips its own version **unless it is marked
restored**, in which case it is applied like any remote version (the trash took the file off disk).
The usual staleness and disk-hash checks make a replay after a reconnect write nothing.

Legacy rows survive: the migration flags the pseudo device `is_restore = 1` (matching an empty
`plugin_version`, so a real device a user renamed to that name, #330, is not caught) and marks the
versions it authored `restored = 1`. Those rows are excluded from every device list and count, and
renaming or revoking one is refused with 403. History labels them `Restored from trash`; a real
device's restore reads `Restored from trash on <device>`.

`PROTOCOL_VERSION` is 6 as a result: a protocol-5 plugin would skip its own restore and lose the
file, so the gate blocks it with an update prompt (#529) rather than let it through. A protocol bump
ships only through a full release: `deno task release` bumps, tags and deploys plugin and server
together, never a server-only `deploy/deploy.sh`.

## 4. Auto-purge

On server start, the server purges rows where `trashed_at` is older than the retention window. The
default is 30 days, configurable with `GEODE_TRASH_RETENTION_DAYS`, which acts as a floor: the
effective window is always `max(server, client)`. The trash list response carries `retention_days`, so
the client can show the server's real cutoff (#532). The plugin counts a row as expired with the same
`max(client setting, server floor)`, and `trashRetentionDays` is the client setting. The table grows
with every deletion; the auto-purge is what bounds it.

## 5. Delete forever erases the history (#582)

The rule: never lose an edit, and never touch a live file's history. A purge reaches the versions, so a
device token may only purge a row past the server's retention floor (`GEODE_TRASH_RETENTION_DAYS`).
Inside the floor the route answers `403 { error: "purge_requires_admin" }` and only the admin token
purges (#677). The trash modal asks for the admin token first, the same prompt the Devices view uses for
revoke (`plugin/ui/admin-token-modal.ts`). A prompt dismissed without a token purges nothing. An older
plugin that purges without one shows the `403` as `Failed to purge. Server error (403):
purge_requires_admin`. Every other destructive trash route is already bounded: `purge-expired` clamps
its cutoff up to the floor, `purge-all` needs the admin token, and the server's own startup and
per-compaction purges use the floor. A vault configured with `GEODE_TRASH_RETENTION_DAYS=0` has no
floor: there a device token can purge anything, which is what that setting means.

`plugin/sync/history-fetch.ts` `eraseChain` drains the History walk from the trash row's own version and
returns `HistoryWalk.chain`: every name the file lived at, with its ceiling (the marker that closed it,
or the row's own version for the last name). The trash modal sends that list, and
`server/trash-erase.ts` `eraseHistory` erases it in one transaction.

- **Generation start**, per name: the newest rename marker or note below the ceiling. A marker closed the
  previous file's generation, so the erase starts after it. A note opened this one, so the erase includes
  it. A plain tombstone is not a boundary, because a restore continues the same generation, and nothing
  above the ceiling is touched.
- **The head row survives** (`to = min(up_to, head - 1)`). A name left with no rows breaks its own
  version order for good, as the note at the top of `server/trash-erase.ts` says: the next create sends
  the head it saw as the parent and the server has head 0. Erasing up to the head minus one keeps the
  tombstone, or the rename marker, which carries no content, so the name continues at head + 1.
  `test/scenarios/sync/trash-delete-forever.test.ts` covers it: after a delete forever, re-creating the
  old name reaches the peer.
- **Consequences**: a reused name keeps the newer file's saves. The chain's own marker and note go; a
  kept note would keep the file's content bytes. An honest client never touches another file's markers
  and notes. The server cannot prove a chain's ownership, so a token holder can name another file's dead
  generation (erasing its saves, never its head) but never live content (`docs/architecture/server.md`).
  Past the floor that is content gone, and the next GC pass drops the blobs; inside the floor the admin
  token is required (#677).
- **Refusals**: a `path_hash` with no versions in the vault (`400`), a walked cap that is not a rename
  marker or note (`400`), any ceiling that reaches a live head (`409`), and a chain that is not
  parseable or has more than 32 entries (`400`). All or nothing, so a refused erase never leaves a
  half-erased chain. Duplicate entries are dropped, and an entry for the trashed name itself is ignored
  because the server derives that one from the row.
- **A walk that fails aborts**: the plugin shows "Could not read this file's history. Nothing was
  deleted." and purges nothing. It does not offer a partial erase, because the confirmation promised the
  past versions.
- **Blobs**: GC is a reference scan, so the next compaction pass reclaims the erased rows' chunks
  (24 h mtime grace). `purge-expired` runs inside that pass; a single delete forever waits for it.
- **Wire**: an additive HTTP route and body only, so `protocol_version` stays 5. An older plugin keeps
  working and gets the own-generation erase through its `DELETE`.
- **Every other purge** (`purge-expired`, `purge-all`, the startup purge and the per-compaction purge)
  has no chain to walk, because names are encrypted and no client is involved: it erases each row's own
  generation and nothing else. A renamed file writes no trash row, so no purge can reach a renamed
  file's history at all. A row whose erase is refused, because its name is live again, still leaves the
  trash; its versions stay.

## 6. Plugin trash view

The settings tab has a Deleted files row with a live count and a View button
(`plugin/ui/trash-settings.ts`). The button opens the trash modal (`plugin/ui/trash-modal.ts`), which
lists trashed files as selectable rows showing:

- path, decrypted client-side from `path_ciphertext` with the vault content key, falling back to a
  shortened `path_hash` when decryption fails
- when it was trashed (relative, for example "2 hours ago"), which device deleted it, and when the
  server will purge it
- per row: Restore, History, View, Purge (delete forever)

Bulk actions in the toolbar: with nothing selected, Restore all and Purge expired; with a selection,
Restore selected and Purge selected. The toolbar shows the server's retention window, so a client
cannot promise a longer one. A purge of any row inside that window asks for the admin token first
(#677, the same prompt as Devices, Revoke). Dismissed without one, it purges nothing and says so in a
notice.

## Decisions

### Auth model

Device token for per-file restore, and for a per-file purge of a row past the retention floor. Admin
token for any row inside the floor and for `purge-all`, the bulk purge of all trash (#677). Everyday
recovery works from any device's UI, and an erase the server is still keeping for recovery has a
separate gate.

### Delete forever erases the history (#582)

Delete forever and purge erase the file's version rows, not just the trash row. Names are encrypted, so
the server cannot walk a rename chain: the client sends the chain it read from the file's History
(`path_hash` plus a version ceiling per name). The server re-derives each generation's start, refuses a
live head, and keeps every other file's markers and notes. Bulk and automatic purges never get a chain,
so they erase only a trashed name's own generation. That is why a renamed file keeps its history through
them: it has no trash row, because its marker is not a deletion. Erasing a chain's own marker and note
is deliberate: a kept note carries the file's content bytes and chunks, so the file would not be gone.
