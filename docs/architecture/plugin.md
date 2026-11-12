---
covers: [plugin/main.ts, plugin/session.ts, plugin/plumbing/*.ts, plugin/sync/*.ts, plugin/ui/*.ts, plugin/manifest/styles.css]
---

# Plugin (Obsidian, desktop + mobile)

**Depends on:** `server.md` (protocol), `../crypto/encryption-chunking.md` (everything in `core/`).
**Leads into:** `merge.md` (when a commit comes back as a conflict).

Most of the code lives here. Target ceiling per file is 300 code lines; the hard cap is 500
(CLAUDE.md rule 5).

---

## 1. Lifecycle & lock

```
onload
  ├─ load settings (shallow merge over DEFAULT_SETTINGS)
  ├─ read the re-key cursor, activity log, last-backup stamp (all plain JSON)
  ├─ delete the legacy in-vault key cache (#534)
  ├─ register commands, status bar, settings tab, file menu, conflict counter
  └─ startup modal → setup wizard, or unlock
```

Unlock paths, in `plugin/plumbing/vault-lock.ts`:

- `tryCachedKeys` takes the cached keys from Obsidian's per-device storage, checks the cache age against
  `unlockTimeoutHours` (default 24) and verifies them against the stored verifier.
- `unlockVault(passphrase)` derives with the vault's `argon2Params`, checks the verifier, caches the
  keys and starts the session.
- `unlockAfterRemoteRekeyFlow` handles a verifier that was rewritten elsewhere (#560): fetch the vault's
  current salt, verifier and params, derive with those, rebuild the local path hashes, resume.
- `finishRekey` is the device that ran the re-key: it swaps the keys and restarts the session. Its rows
  are rebuilt at go-live by the stale-row repair (`sync/stale-rows.ts`, section 6).

Lock (`lockVault`) clears the key cache and disposes the session. `leaveVault` also revokes the device
on the server (best effort) and deletes every local state file. Disposing starts the last state writes
(`StateDB.close` flushes the armed local-files throttle and always persists the cursor); the leave
drains them (`awaitStateWrites`, #744) before it deletes, or a late rename recreates a file it just
removed and an unconfigured vault keeps sync state. A vault is either locked (no keys in
this session) or unlocked; while locked there is no transport, so apply and commit cannot run.

`startUnlockedSession` defers `transport.start` and the event handler to `workspace.onLayoutReady`, so a
large vault does not block Obsidian's load.

**Re-key auth registration** (`registerAuthTofu`, `plumbing/rekey-client.ts`) rides three paths: the
create and join flows register with the **admin token** they already hold, the two unlock paths with
the device token only. The server demands the admin token for a vault's *first* `auth_hash`, and for
its first `verifier` (`putVerifier`) (#675), so a vault that only ever auto-unlocked keeps
`auth_hash = NULL`; the unlock registration then fails with 403 and is logged, never fatal. A rekey on
such a vault stops before any session with a clear error (`sync/rekey-run.ts`), because the plugin
keeps no admin token.

---

## 2. Settings

Stored in `data.json` (the Obsidian plugin convention). It holds the verifier, never the passphrase.

```ts
type PluginSettings = {
  serverUrl, vaultId, vaultName, deviceId, deviceName, deviceToken, salt, verifier: string;
  argon2Params: { ops: number; mem: number };   // authoritative per vault (Hard rule 7)
  unlockTimeoutHours: number;                   // key-cache lifetime, default 24
  syncObsidianConfig: boolean;                  // gate for the whole config dir
  syncedPlugins: string[];                      // per-plugin config dirs that sync
  configCategories: ConfigCategory[];           // #454: appearance|snippets|hotkeys|corePlugins|other
  excludedFolders: string[];                    // #342: subtrees out of scope, trailing slash
  includedFolders: string[];                    // exceptions inside them
  pendingCatchUpFolders: string[];              // re-enabled scope awaiting a server catch-up
  pendingMoveOuts: Array<{ oldPath; destFolder; destPath? }>;  // #584 parked moves
  debugLogging: boolean;
  trashRetentionDays: number;                   // clamped to the server floor (#532)
  pauseAt: number;                              // 0 = not paused
  massDeleteHold: MassDeleteHold | null;        // #601 held delete, survives restart
  massDeleteMinFiles: number;                   // guard: 20 files and 25% (both must trip)
  massDeleteMinPercent: number;
  updateNoticeVersion: string;                  // #44: plugin version the server update notice was shown for
};
```

`NEW_VAULT_ARGON2_PARAMS` (Standard, `ops=3, mem=256 MiB`) applies to vaults created from now on.
`DEFAULT_SETTINGS.argon2Params` stays at `ops=3, mem=64 MiB` and only fills a missing field, so an
existing vault never silently changes params.

Scope helpers (`isSyncable`, the category to path mapping) live in the same module. Obsidian's config
dir is never hard-coded; it comes from `vault.configDir`. The rejoin backup folder (`Geode backup/`) is
the one other path `isSyncable` rejects on every device, before the folder scope (#701, §7a).

---

## 3. Local state

No SQLite. `plugin/plumbing/state.ts` keeps two in-memory maps (by path, by `path_hash`) plus the sync
cursor, and `state-persistence.ts` mirrors them to JSON files in the plugin data dir
(`<configDir>/plugins/geode/`):

| File | Holds |
| --- | --- |
| `local-files.json` | one row per path: `path_hash`, `size`, `mtime`, `plaintext_hash`, `last_seen_version`, `chunk_hashes`, `deleted` |
| `sync-cursor.json` | `last_seen_seq` + `last_backup_at` (plus a fixed `vault_id: "default"`), and `in_flight_apply` while a write of downloaded or merged bytes is in flight (#59) |
| `activity-log.json` | the per-device activity log behind the activity modal |
| `rekey-cursor.json` | resume cursor of an open re-key run (#559) |

Rules:

- **Row writes are throttled** (2 s trailing), so a drain costs O(seconds) writes, not O(files) (#328).
  The sync cursor is written immediately: a stale cursor would replay past an applied edit.
- **Every write of bytes this device did not type is recorded before it starts** (#59): one entry
  `{path, path_hash, expected_plaintext_hash}`, written (and awaited) by `recordedWrite` immediately
  before that path's write and cleared right after it returns. Rows persist on the throttle, so
  without that record a force-stop mid-write leaves a torn file whose row never landed, which reads as
  a local create. A write that cannot be recorded does not happen (fail closed), and cursor writes ride
  one chain in order, so a slow one can never land after a newer one; a caller waits at most 10 s for
  its own write and then fails closed, while the chain keeps the hung write in place. Network fetches
  are bounded (60 s) so a silent socket fails an apply before it writes anything, and applies stay
  serial.
- **Ordered cursor advance**: only a contiguous run from the current cursor is persisted. An
  unaccounted seq halts the run, so a transient apply failure cannot be leap-frogged (#369).
- **No temp-file-plus-rename on the state path**: it starved the mobile FS bridge (#181). A torn file
  parses as absent and the reconciler rebuilds it.
- A **rejoin** reads these two files as the witness of what this device last agreed on: rows present, or
  `last_seen_seq` above zero, means the folder a join lands on is an old copy of the same vault (#701,
  §7a). A first join into a folder of unrelated notes has neither.
- `version_cache` does not exist here. The bounded in-memory cache of applied `ServerVersion`s lives in
  `sync/replay.ts` (256 entries).
- The **key cache** is not a file: `app.saveLocalStorage("key-cache", …)` writes to Obsidian's
  per-device storage, so copying the vault folder never copies keys (#534).

---

## 4. Transport (`plugin/sync/transport.ts`)

### Responsibilities

- One WebSocket to `/vaults/:id/sync`, with `hello` carrying `last_seen_seq` and `plugin_version`.
- Reconnect with exponential backoff from 1 s, capped at 60 s.
- Route inbound `server_version` messages to the apply/merge pipeline, ack and conflict messages to the
  commit channel, and `hello_ack` to the version and re-key banner logic.
- Parse each frame defensively (#680 L-3): a frame that is not JSON is logged and dropped. It used to
  throw out of the `"message"` listener, where nothing catches it, so it surfaced as an uncaught error
  and the frame was lost anyway. The other `JSON.parse` sites read an HTTP body or a local state file
  inside an awaited step whose caller already turns a failure into a failed sync or re-key step.
- HTTP client (`sync/http-client.ts`) for blobs, `/heads` and `/versions`; `plumbing/storage-client.ts`
  for `/storage`.

### States

`disconnected | connecting | connected | syncing | live | blocked`

`syncing` means replaying server history; `live` means caught up. Commits are queued while not live and
drained on `live`. `blocked` means a hard version refusal, where the update prompt is the only way out
(#625). `live` is a transport fact (every version received), so it comes before the replay buffer
drains: the drain publishes its whole backlog as `applying 0/N` before it downloads anything, and the
status bar shows the syncing spinner from that first event until the drain-complete marker (#59, #319).

### Commit channel (`plugin/sync/commit-channel.ts`)

One in-flight commit at a time, in an ordered queue:

```ts
type CommitRequest = {
  path_hash; parent_version: number | null; enc_metadata; chunk_hashes; deleted;
  path_ciphertext?; rename_mark?;
};
type CommitResult =
  | { kind: "ack"; seq; version }
  | { kind: "conflict"; path_hash; parent_version; reason }
  | { kind: "error"; message };
```

Acks carry **no commit id** (#359), so a result only ever settles the in-flight commit. Every in-flight
commit is bounded: `COMMIT_TIMEOUT` (30 s) drops the socket so the reconnect cannot deliver a stale ack,
and a socket that closes settles it immediately; a commit left pending would wedge the channel (#616).
A failed commit is requeued and resent on the next live drain. A resend the server already applied comes
back as a conflict on an identical self-authored head and resolves as a no-op.

### API

```ts
class Transport extends EventTarget {
  start(serverUrl, vaultId, deviceId, deviceToken, lastSeenSeq, pluginVersion): void;
  stop(): void;
  isLive(): boolean;
  commit(req: CommitRequest): Promise<CommitResult>;

  getBlob(hash): Promise<Uint8Array>;
  putBlob(hash, body): Promise<void>;
  headBlob(hash): Promise<boolean>;
  getHeads(afterSeq): AsyncGenerator<HeadRecord>;
  getVersionChain(pathHash, upTo?): Promise<VersionRecord[]>;
}
// events: "version", "live", "status", "reconnect", "hello_ack", "blocked"
```

HTTP goes through `plumbing/http-platform.ts`: `requestUrl` on desktop, `fetch` on mobile. The Electron
renderer's `fetch` is CORS-blocked, and `requestUrl`'s binary POST is broken on Android (#133).

---

## 5. Vault events & the pending queue (`plugin/sync/events.ts`)

Wired in the unlocked session via `app.vault.on(...)`. These fire for Obsidian-mediated changes only; see
§6 for the rest.

| Event | Action |
| --- | --- |
| `create` / `modify` (TFile) | enqueue a `commit` op |
| folder events | ignored, because folders are implicit in paths |
| `delete` (TFile) | enqueue a `delete` op; also checks for the file appearing under `.trash/` (an Obsidian delete is a move) |
| `rename` | in scope → in scope: marker + note pair (#583); normalization-only change: one `commit`; across an excluded-folder boundary: a parked move (#342/#584) |
| self-writes | suppressed for 3 s so our own apply is not re-committed |

### Debounce

A **fixed 2 s window** per path (`PENDING_WINDOW_MS = 2_000`): the first uncommitted edit opens the
window and later edits inside it do not reset it, so the commit is sent at most 2 s after the first edit.
The window is not a separate idle timer. "Push now" flushes immediately.

### Pending ops

```ts
interface PendingOp {
  path: string;
  kind: "commit" | "delete";
  scheduledAt: number;     // stamped by the event layer
  renameId?: string;       // #583: links this op to the rename that produced it
  renamedTo?: string;      // a delete's destination
  renamedFrom?: string;    // a create's source
}
```

The event layer holds ops in memory and flushes them into the shared queue (`sync/commit-queue.ts`)
every 5 s, or immediately on a flush. That queue is also filled by the reconciler and by the reconnect
drain, so all three feed one ordered list. A superseding op for the same path keeps the rename link. A
failed op is retried up to 5 times and then parked as "dropped" for the status bar. Nothing is
persisted: after a restart the reconciler rebuilds the same intents from disk against the state rows.

---

## 6. Reconciler (`plugin/sync/reconciler.ts`)

This is what keeps the plugin correct against edits it never saw a vault event for.

### When it runs

- Immediately on start (`startReconciler`), then every 5 minutes (`RECONCILE_INTERVAL`).
- **Stale-row repair** runs before the scan on a go-live that starts a reconciler (#53). A row whose
  `path_hash` differs from the hash of its path under the current `mac_key` predates a re-key on this
  device. A file on disk, a closed row or an out-of-scope path only gets the hash corrected. A live row
  with its file gone applies the head through `catchUpFolders`, which rewrites the row: a live head
  restores the file, a head closed elsewhere closes the row. One with no chain under the current hash
  has nothing to restore and closes at version 0. A failed download stays stale and retries at the next
  connection.
- **A stale hash never sends a delete.** It has no chain on the server, so a parent of 0 would open one,
  and every peer would apply the tombstone. `commitDelete` throws `StaleHashDelete`: a conflict resolution
  shows the error, the activity log records it, and the queue neither retries nor counts it as dropped,
  because a retry could land after the repair brought the file back. A mass delete decision on such a
  path does not take effect: the file returns at the next go-live. A rename made while stale is not undone: its new name stands,
  and the old name comes back when the server has a head for it.
- On every go-live: `SyncManager.startReconciler` stops the previous reconciler first, so reconnects
  never leave a second scanner running (#622).
- "Reconcile now" forces a pass; otherwise a run within half the interval is skipped.
- The config dir is a constructor input (`Vault#configDir`, passed by `SyncManager`), never assumed to
  be `.obsidian`: users can rename it.

### Algorithm

```
inputs: localFiles (state rows), disk (adapter.list, or getAllLoadedFiles + the config dir)

# Pass 1: disk → state
for each disk file in sync scope:
  if a download batch is writing it, or a killed one left it (#59): → nothing
  if no row, or the row is closed:            → create candidate
  if row.last_seen_version == 0:              → modify (a rename carried an edit here, #613)
  if mtime matches the row (markdown only):   → skip
  if size and mtime match the row:            → skip
  else hash (normalized markdown identity):   equal → update mtime only; differ → modify

# Pass 2: state → disk (deletes)
for each row not closed and not in scope now:
  skip if the file is on disk, if this device already queued a rename of it, if this
  device already queued a plain delete of it, if a download batch is writing it (#59),
  or if the server head is a rename marker;
  otherwise → delete candidate
  (one server round trip per candidate, at most 8 in flight)

# Pass 3: pair missed renames (#583)
one delete + one create with identical content → rename marker + note (1:1 only, hashes
  computed for candidates only, so a pass with no deletions reads nothing)

# Pass 4: mass-delete guard (#601) on the UNPAIRED deletes
if count >= massDeleteMinFiles (default 20) AND count*100 > tracked*minPercent
  (default 25), where tracked counts live (not closed) rows: hold everything (creates
  included), persist the hold; nothing syncs until the decision
```

A paired delete becomes a rename marker and the paired create a forwarding note, the same op shape the
vault-event path emits. A folder renamed while Obsidian was closed therefore links file by file instead
of re-uploading every file.

### What it explicitly does NOT do

- No similarity matching and no mtime pairing, and never a batch whose content repeats (identical notes
  cannot be told apart).
- It does not scan paths outside the sync scope (excluded folders, config dirs of plugins that are not
  in `syncedPlugins`).

---

## 7. Apply (remote → local) (`plugin/sync/apply.ts`)

Inbound `server_version` messages go to disk. `replay.ts` serializes this through the version queue,
buffers until `live`, and coalesces superseded versions per path. On the flush it reports the whole
backlog (`applying 0/N`) before the first apply, then the applied count per file.

```
applyVersion(v):
  if v.device_id == this device:            # our own echo
    rebuild the row from v's metadata, advance the cursor, never write to disk
    return
  if the row already tracks v (or newer):   # stale or replayed version
    keep an untracked disk edit alive, advance the cursor
    return

  meta = decryptMetadata(v.enc_metadata, keys, v.path_hash)
  if skipsApply(path):                      # out of scope, or a parked excluded name (#584)
    advance the cursor, return              #   (never write the old name back)

  if meta.renamed_from and a carried row waits there (version 0):
    the edit follows the note to its new home (#613); the abandoned name is never re-created

  if v.deleted:
    if v.rename_mark == 1:      # a move, never a delete conflict (#583)
      a pending local edit moves to the destination (or a sibling conflict file if taken);
      the old name is left empty, row closed at v.version, the new head is resolved
    elif a local edit is pending (queued OR disk drifted, #589):
      conflict, local wins (#361)
    else:
      delete the file if present, close the row at v.version
    return

  if a delete of this path is queued and the file is gone:     # #593, inside applyContentOrConflict
    same content: keep the row open at v.version (the queued delete tombstones the head)
    otherwise apply the content, cancel the queued delete (else it would tombstone the
    restored version), record "restored"
    return

  if the row has local edits: → conflict path (merge.md)

  else: reassemble → write via the vault IO layer → update the row + cursor
```

**A kill mid-write leaves a fragment, not an edit (#59).** A download, a merge result, a history
restore, a kept conflict sibling and a rejoin backup copy all go through `recordedWrite`, which records
the path (with the hash the bytes are meant to have) right before the write and clears it right after.
One pass at the next connection resolves every entry, and clears each one it resolved, so no path is
ever frozen by a stale record:

| Disk holds | Resolution |
| --- | --- |
| nothing on disk (positively absent) | the write never reached the disk: clear; an UNREADABLE file is not absence and stays recorded |
| the server head | the write landed: clear |
| the row's hash | nothing was written: clear, force nothing |
| the entry's expected hash | the write completed and the commit/merge after it did not run: clear, the normal reconciler takes the bytes (with or without a head) |
| shorter than the entry's expected size, no head | a torn copy of this device's own: removed |
| a strict prefix of the head's bytes | torn: the head is applied over it (the record is still up, so the apply never reads the fragment as an edit) |
| anything else, with a head | an edit made outside Obsidian after the kill: kept as a local edit, never overwritten (the divergent-edit path merges or conflicts it) |
| anything else, no head | somebody else's bytes on a path the server never had: kept, never deleted. Heads are never compacted away, so no head means this device's own copy at most |

An entry the pass could not resolve (the server did not answer, or a vault write errored) stays
recorded, and with it gated, and the next connection tries again: that only waits while nothing can
sync anyway. While it is unresolved, a version for that path is **parked** (not applied; the cursor
stays behind it), because the bytes on disk may be an edit made outside Obsidian, and only the pass
may judge them. When the pass resolves that record in the same session, the parked versions are
re-applied through the same serialized queue, so the cursor advances then, not at the next
connection. A pass that a bound abandoned keeps running: the next pass skips the entries such a
pass still owns, so two writers never resolve one path at once.

The pass as a whole is bounded (10 s): it is the only thing that rewrites a file a killed process left
mid-write, which is where a mobile FS bridge can wedge on the handle the dead process held. A wedged
pass costs one wait, never the session; everything it did not get to stays parked and gated, and the
abandoned pass keeps running: what it resolves in this session releases its parked versions, and the
rest is retried at the next connection. Its verdicts are local where they can be (nothing on disk, the row's bytes,
the bytes the write meant to leave) and otherwise need the head: the head's identity hash, and only
for the "is this a prefix of what it was writing?" test the chunks the short file covers. Bytes with
no head at all are removed only when they are shorter than what that write meant to leave (we know
its hash and its length, not its bytes); anything longer is somebody else's and is kept. Fetch bounds are per request (60 s) and a blob is one chunk of at most 1 MB
(`core/chunker.ts`), so no request a large file needs can outlast that.

While a path is torn, `StateDB.isTorn` is what both the apply and the reconciler gate consult: no pass
may commit or close it, and a rename marker does not carry it to the new name. An edit the user has
queued or not yet flushed wins over the fragment, because that is their typing, not a dropped write.

**Writes go through `vault-io.ts`**: `modifyBinary` for a file the vault index knows, `createBinary` for
a new one, and `adapter.writeBinary` as the dot-file or pre-index fallback. The write is given the
version's `mtime`, and the row stores that same value, or the reconciler's size+mtime fast path would
re-read the file every pass (#630, §8).

**A rename never closes an open note (#697).** When the vault index knows the old path, applying a
rename moves the file with `vault.rename` and only then writes or merges at the new name: Obsidian takes
an open editor with it, where the write-new + remove-old pair tore it down and dropped the keystrokes
typed after that moment (#695). The same primitive covers the three rename outcomes: a carried edit
moves with the file, a taken destination moves the old file to the `(conflict ...)` sibling (its bytes
are then written back, which is what makes the sibling's `modify` event commit it), and a clean note
follows its own name. Wire rename, row bookkeeping, merge and cursor advance are unchanged.

**A carry that finds its own bytes at the destination carries nothing (#55).** A case-only rename on
a case-insensitive filesystem is one inode under both names, so the pending edit read at the old
spelling is the destination's own file: `carryLocalEdit` compares the two by content identity and
answers "same" instead of keeping a sibling that would sync as a duplicate note. Both names of a
case-only rename hash as one file (an extension-only case change, `note.md` to `NOTE.MD`, would
otherwise flip markdown-ness); a real rename hashes each side under its own name, so a markdown-ness
change (`x.md` to `x.canvas`) is never the same bytes. The bytes decide, not the destination's row:
its own head may have applied first. Every outcome that reaches the destination (moved, sibling,
same) leaves the renamed-away name empty, so the caller only closes its row: a file left there is
re-derived as a new note beside the real one on each reconcile pass. `none` (nothing pending, an
unreadable source) touches nothing. Before a separate old file goes, both sides are re-read; when
either moved on since the match, both are kept in a sibling instead.

**When a clean note follows.** The old file moves onto the destination only while the server's head
there is open, meaning no marker closed it. An open head need not be this rename's note; the move is
then wasted, not lossy, because the next applied version overwrites it. A later content version counts too: the peer may have typed
in the new name before this device applied the move. A destination with no version at all is re-read for
a moment, because the peer commits a marker and its note back to back, and a name that no note opens (an
intermediate name of a collapsed rename chain) is never created. A destination this device excludes is
not written. Where the index does not know the old path, or `vault.rename` fails, the old name closes as
before, which for a clean rename is a removal and nothing else.

**Self-writes and echo.** Suppression is the pair, not the path: a `rename` event is dropped only when
it matches the (old, new) pair the apply registered, so a user's own move of that file to another name
in the same window still syncs, and an echo at either path cannot consume the mark. The row a move
leaves at its destination carries no version of its own and the hash of the bytes it moved, so the
reconciler leaves it alone until the note's version lands, while a carried edit (bytes that differ from
that hash) is still committed. Nothing else commits such a row: if the destination's version can never
be applied, the file stays local until it is edited. A rename dropped by that window is re-linked by the reconciler's
missed-rename pairing (§6).

The **origin echo** (our own commit fanned back) is filtered by `device_id` and only refreshes the row and
the cursor; the bytes are already on disk. The one exception is a **trash restore** (#687): the server
credits it to the device that asked for it, so that device receives a version it authored but is
missing from disk. `v.restored === true` sends it down the normal remote path, where the usual
staleness and disk-hash checks keep a replay after a reconnect from writing twice.

---

## 7a. Join over an existing folder (rejoin, #701)

A join is a **rejoin** when the previous settings named the same vault id this device is joining AND old
state survived: rows in `local-files.json`, or `last_seen_seq` above zero (`isRejoin` in
`sync/join-plan.ts`). The two files fail independently, so either one detects it. Any other join is a
first join and still uploads the folder, including a reinstall whose plugin data is gone, which keeps no
vault id to compare and is not detected (a follow-up, not handled here).

A rejoin never starts a session on the old state. That session would read the months-old folder as local
edits and upload it back over the server's deletes: the #701 bug. `sync/rebuild-flow.ts` instead
disposes the runtime, rebuilds from the persisted rows over a bare transport carrying the device token
the join just issued (the live session still holds the old, revoked one), and restarts the session.
Per path:

| State | Result |
| --- | --- |
| row open, disk hash equals the row hash | the server version wins silently: an edit is written, a delete or a rename applies |
| row open, disk hash differs, the head or the chain holds exactly those bytes | a stale copy of a version already synced: the server wins, nothing is copied (history can still restore it) |
| row open, disk hash differs, the server does not know those bytes | a real edit: kept, then the normal commit/merge/conflict path |
| no row, or a closed row | doubtful: copied to `Geode backup/<stamp>/<path>` first, then the server wins |
| nothing on disk, a live head on the server | written, as in any rebuild |
| the adapter cannot read the file | kept, never pruned: nothing could be copied out. A delete head still removes it: a permanently unreadable file cannot be confirmed as an edit |

`sync/rejoin.ts` (`prepareRejoin`) runs before the head loop. A path whose bytes equal the live head is
answered by the heads the rebuild already fetched; the rest costs one `getVersionChain` read per path
(capped at 200, 8 in flight; past the cap a live row is kept as an edit and anything else is copied, and
an unreadable chain counts as unknown). Then the copies are written, before any head is applied: a
failed copy write aborts the rebuild with nothing removed. `apply`'s `trustDiskDivergence` dep is what
turns "divergent bytes" into "the server wins" for the paths a rejoin does not keep, and
`pruneExtraneousFiles` removes the in-scope files with no live row that the prepare snapshot did not
keep: their bytes are in the backup folder, unless the file appeared on disk *after* the snapshot: the
prune runs after the heads, so that file is removed without a copy. The window is the rebuild itself,
while nothing else should be writing. Heads apply in parallel in both rebuild paths, so
`rebuildFromScratch` always sets
`recheckDiskBeforeWrite`: apply re-reads the disk right before writing and keeps bytes that arrived in
between (a rename marker's carried edit landing at its destination). No wire protocol change: the rebuild
uses the existing heads stream and version chain. A conflict copy the rebuild makes carries this
device's name: `deviceName` is part of `ResyncDeps` and reaches apply, so the file that syncs to every
device never holds the fallback label (#55).

A rejoin that fails part way pauses sync (`pauseAt`, persisted, and shown by the status bar at once) and
sets `rejoinIncomplete` before rethrowing: the settings already carry the new device, so a stop plus that
marker are what keep the old rows from being replayed. While the marker is set, every path that would
start a session or rebuild (Resume, the next unlock, "Resync from scratch") finishes the rejoin
instead. Joining again works too: the join's identity write drops the marker and lifts the pause the
marker left, and the rebuild that follows finishes the job. A completed rejoin clears the marker and lifts
the pause *it* set, in both places a finish can happen (`rebuildVault` for Resume, Resync and a session
start; the identity write for a join): a pause the user chose survives all of them, because a rejoin *is*
the restore-everything decision only for what the rejoin itself stopped. For the same reason it discards a
pending mass-delete hold, exactly as "Resync from scratch" does (and, unlike resync, without waiting for
the held connection, since a rejoin runs over its own transport).

A rebuild that is not a rejoin (Resync from settings or the palette, Resume) that dies BEFORE it reads
its head list restarts the session on the persisted rows before rethrowing: the dispose above is the
rebuild's first step, so without that restart sync would stay stopped until a reload, and those rows are
exactly what a normal start reads. Past the head list it does not restart. `rebuildFromScratch` reports
`onRowsMayChange` there, and the rebuild PERSISTS `resyncStop` (the `rejoinIncomplete` pattern) before it
can change a row: a force quit, an OOM or a reload mid rebuild then lands on the stopped state instead of
replaying half-restored rows as deletes (the mass-delete guard stays silent below 20 files). The value is
the engine's own message, replaced with it when the rebuild fails and `Resync did not finish.` when a
crash left no message. A retry that fails before its head list still sees the marker a previous failure
left, so it keeps the session stopped instead of restarting on rows that one may have changed.

The marker is cleared by a completed resync (once the rebuilt rows are durable and before its own
restart, so a restart that throws leaves no marker: the rows are consistent by then, and that failure is
answered with the dispose path), by leaving the vault, and by a new vault identity (`withVaultIdentity`:
create or join). While it is set, every
session start lands on the stop: a reload and an unlock both come up showing `Resync stopped. <reason>`
with Try again, and a held mass delete is still announced behind it. That state also outranks the user
pause, because "changes upload when you resume" would be false with no session behind it; every other
state keeps its usual order. The rebuild builds its own transport and starts it only once the session's
is stopped, so a held delete's reconnect and the rebuild never hold two live connections from one device
(the server evicts the second as a duplicate); that also makes Try again work with no session at all. A
retry that cannot even start is shown as a stop, never only logged. A rebuild that can never complete is left
with one way out, like a stuck rejoin: leave the vault and join again.

A rejoin whose cause cannot be fixed (no space for the backup folder, a file named `Geode backup` in the
vault root, or a blob the server can no longer serve) has one way out: free the space (or rename the file),
or leave the vault and join again. Nothing else clears the marker, and every session start keeps retrying
the rebuild until one of those. A new vault identity (a create or a join of another vault) drops the
marker, so a stale one can never rebuild a different vault's folder.

`Geode backup/` is a visible vault folder that never syncs. `isSyncable` rejects it on every device
before any other rule, so its contents can never become a create, and the conflicts list and its count
skip it (`merge.md` §6).

The setup wizard warns before the join runs and reports the count and folder in its Done step. Resync
from scratch keeps its own rule: a divergent file is kept for the merge, because a lost row table on a
live device most likely hides a real offline edit; a rejoin is the opposite situation.

---

## 8. Commit & conflicts (`plugin/sync/commit.ts`, `conflict-handler.ts`)

`commitOp` per queued op:

```
stat the file, then read it                          # mtime must belong to bytes read after the stat
plaintext_hash = blake3Hex(normalizeForHash(path))   # markdown: EOL + BOM normalized first
for each chunk: hash it, upload if the server doesn't have it (HEAD), encrypt with the chunk hash
meta = { path, mtime, size, mime, plaintext_hash, renamed_from?, renamed_from_version? }
commit({ path_hash, parent_version: row.last_seen_version, enc_metadata, chunk_hashes,
         deleted: false, path_ciphertext, rename_mark })
  ack      → update the row, log
  conflict → handleConflict → merge.md
```

Two rules keep the row describing the bytes on disk (#630):

1. **Stat before read.** A writer outside the path lock (apply, conflict resolution, history restore) can
   land in between. Statting afterward would put that write's mtime on an older row hash, leaving row
   and disk disagreeing under one mtime, so the fast path never re-reads them and this device keeps a
   version its peers do not have.
2. **One writer per path** (`sync/path-lock.ts`): `commitOp` and `ConflictHandler.resolveConflict` take
   the same lock, and a commit hands its conflict to the handler only after releasing it. The acquire is
   bounded, so a commit over a dead socket defers instead of stalling the version queue.

A **delete commit** closes the name, either as a plain tombstone or as a rename marker (`renamed_to` plus
`rename_mark: 1`). It skips work when the row is already closed, when the path is the middle of a
collapsed rename chain (#615), when the destination never opened (#629: one plain delete instead), and
when the file is still on disk unless this is a rename (the #498 guard must never eat a marker).

A **write at a name the server closed as a peer's rename marker** either follows the note or is a new
note (#695, `followClosedRename`). It follows only when the content says so: not markdown → new note;
empty or whitespace-only → new note; the marker's target is not on this device's disk → new note; past
256 KB, or a file whose repeated lines would make the line diff quadratic, → new note; at least 80% of
the target's characters survive in the file → late save, carried with both edits kept. Everything else
stays: the file opens a new generation at the name with a plain commit over the marker head. A vault
`create` is no evidence either way, because Obsidian reports Ctrl+N and a stale editor's save alike, so
content alone decides, whether the tag came from an event or from the reconciler's scan.

The measure (`sync/late-save.ts`) normalizes both sides like the identity hash does (BOM, line endings),
anchors on lines the two share, and counts what the changed runs share at their head and tail. It is
exact for the one-region edit a save makes, linear for any run, and never a diff inside the path lock.

**Conflicts**: `conflict-handler.ts` holds the retry budget (5) that caps merge → commit → conflict
recursion. Past the budget, and for every `conflict_file` outcome, `merger.ts` writes the server copy to
the path and the local copy to a conflict file (`merge.md` §6).

### Feature modules around the sync core

| Module | Responsibility |
| --- | --- |
| `sync/rename-chain.ts`, `rename-note.ts`, `rename-carry.ts`, `late-save.ts`, `parked-moves.ts` | rename links: collapsed chains, the note a create carries, carried edits, the late-save test for a closed name, moves into and out of excluded folders |
| `sync/replay.ts`, `replay-coalesce.ts`, `version-state.ts` | inbound pipeline, version queue, applied-version cache, version banner state |
| `sync/history-fetch.ts`, `history-restore.ts`, `ui/history-*` | file history walk, preview and restore (follows rename notes) |
| `sync/conflicts.ts`, `conflict-list.ts`, `conflict-resolve.ts`, `ui/conflicts-modal*`, `ui/conflict-review-*` | conflict naming/recognition, the conflicts list, the per file review, resolution |
| `sync/export-vault.ts`, `export-writer.ts`, `recovery.ts` | export a decrypted copy (desktop only: `export-writer.ts` is the one Node user); resync from scratch |
| `sync/rekey-*.ts`, `plumbing/rekey-client.ts`, `rekey-cursor-store.ts` | resumable re-key worker (see `encryption-chunking.md` §1) |
| `sync/mass-delete-hold.ts` | the #601 guard's thresholds, hold record and review |
| `sync/activity-log.ts`, `backup-stamp.ts` | per-device activity feed; last-backup stamp |
| `plumbing/trash-client.ts`, `ui/trash-*` | trash listing, restore, delete-forever (`../ops/trash-soft-delete.md`) |

---

## 9. UI (`plugin/ui/`)

Anything importing `obsidian` lives here. The logic it needs is extracted into `obsidian`-free modules
(`statusbar-icon.ts`, `sync-status.ts`, `tab-state.ts`, …) and unit-tested there.

**Settings tab** (`settings-tab.ts` plus one module per section): Status, Vault, Devices, Sync scope,
Trash, Advanced, and Logs (a page of the unlocked tab, no setting needed). Banners (`settings-banners.ts`) above the
Status rows carry a version refusal, a held mass delete, a sync error, a pause, and the update hint:
one headless section whose row order is that fixed order, each row shown only while its state holds.

Each section yields rows (`settings-legacy.ts` `SettingsRow`): a `render` row decorating the
`Setting` it is handed, or a real control. The tab composes them into one tree of sections
(`settings-tree.ts`, `obsidian`-free) that both Obsidian paths render, so no row exists twice:

- **Obsidian 1.13+**: `getSettingDefinitions()` returns `definitionsOf(tree)`. One page: the
  banners and Status rows without a heading, then the Vault, Devices, Sync scope and Trash groups,
  then Advanced and Logs as sub-pages. Obsidian indexes every row for settings search (banners
  are `searchable: false`) and re-reads the definitions while it does, so the read is pure: section
  objects are built once and `refresh()` is the only thing that rebuilds them, or the rendered rows
  would end up bound to objects the status tick no longer updates. Obsidian runs a render row's
  cleanup when it tears the row down: the Devices poll and the Logs subscription stop there.
- **Obsidian < 1.13**: `display()` hands the same tree to `LegacySettingsView`, which renders each
  section collapsible (Advanced and Logs start collapsed) and supports the subset the tree uses:
  render rows, number and toggle controls, `visible`, cleanups (run on `hide()`).

Four rows are real controls, searchable and bound through `getControlValue`/`setControlValue` onto
`pluginSettings` + `saveSettings()`: Auto lock after (hours), Trash retention (days), Developer
console (also mirrors the log to the DevTools console; the last row of the Logs page) and Sync
config folder (also calls
`setSyncObsidianConfig` and reconciles; Config to sync follows `visible`). Their names live in
`settings-row-names.ts` because the E2E drives the rows by name (a control row cannot carry a testid
on 1.13+), and a refused number puts the stored value back and shows the reason on both paths
(`numberControlChange`). State changes never re-render: rows that hide while locked carry `visible`,
and the tab re-evaluates them in place
(`refreshDomState()` on 1.13+, `refreshVisibility()` before). A structural change (set up, leave,
re-key) calls the tab's `refresh()`: `update()` on 1.13+, a fresh `display()` before. Every
1.13-only call sits behind `requireApiVersion("1.13.0")` (`api-compat.ts` holds `setDestructive`);
`minAppVersion` stays 1.8.7. The E2E hook `legacyForTest` makes 1.13+ render through `display()`, so
one spec (`settings-definitions.spec.ts`) checks both paths show the same rows.

**Devices section** (`ui/settings-devices-section.ts`, its text in `ui/device-status.ts`): one summary
row (`N devices · M behind`, refreshed every 30 s with the device token) whose **Manage** button opens
the Devices view, and one help row with no control at all, `Rotate admin token`. Rotating happens on
the server: a new value in its `.env` and a container recreate, because a plain restart keeps the old
environment (`server.md` §10). The row's one line says that and nothing else.

**Server address** (`ui/server-address-modal.ts`, logic in `plumbing/server-address.ts`): the Advanced
row's Edit modal checks the server before committing and keeps the old address on any failure. The
device-authed trash GET carries the kind: 2xx exists for this device, 401 a revoked or stale device
token (rejoin the vault), 403 a token for another vault, 404 no vault at that address, 5xx or no
answer unreachable. Each kind has its own line; every one ends with "Your previous address is kept."
The scheme is decided in `plumbing/scheme.ts`: a scheme the user typed survives into every request and
into `serverUrl`, a bare host gets `http` on loopback or a private range (10/8, 172.16/12, 192.168/16,
100.64/10) and `https` anywhere else, and an already stored address without a scheme follows the same
rule. The wizard, the flows and the modal all go through it, so no caller re-derives a scheme.

**Server update** (`ui/server-update.ts`, `ui/server-update-logic.ts` for the decisions,
`ui/server-update-modal.ts` for the dialog, `plumbing/update-client.ts` for the calls): a `Server
update` row in Status shows `Server X, plugin Y.` with `Update` while the host job's heartbeat is
fresh, and the copy button when it is not (`server.md` §11). The row is "versions match" quiet
(`Server X.`, no control) and shows only the versions while the server refuses this plugin, because
the refusal banner carries the action there. `Update` opens one dialog: the consequences, then the
session's admin token (the same prompt as Devices, `ui/admin-token-modal.ts`), then the request and
progress in the same dialog, then one result line. Closing the dialog hides it and the run keeps
going: the status row reads `Updating the server.` while it does, and `Update` stays disabled. The
result comes from the job's own words, mapped in `server-update-logic.ts`; a failed or missed run
shows the command instead of pretending. The one-time notice after a plugin update is once per
plugin version (`PluginSettings.updateNoticeVersion`), with the action only when the job can answer
it. A server behind the plugin is no longer a status-line hint: the row and the notice carry it, so
`Up to date. Last backup 2 min ago.` stays readable. The plugin's own update keeps its hint and
banner.

**Status bar** (`statusbar.ts`, `statusbar-icon.ts`): a single icon whose color and tooltip encode the
state: synced with last-sync age, syncing progress, pending count, offline with the retry delay, locked,
conflicts. Clicking it opens the status menu (`status-menu.ts`).

**Resync surfaces** (`ui/resync-status.ts` for the state and every string, `ui/resync-run.ts` for the
notice and the two entry points that own it): a resync owns the status while it runs, whichever way it
started. One state (`running` with progress, or `failed` with a reason and whether it left a session
behind) feeds the single notice that updates in place (at most four renders a second, the last count
always), the status bar tooltip and spinner, the settings sync-status row (blue, then orange), and the
Advanced row's button (`Resyncing…` disabled, then `Try again`). Pause and Reconcile are disabled while
it runs, because a resync has already disposed the session they would act on. A running resync outranks
everything (the transport reads disconnected by design). A stopped one outranks only a healthy session:
a pause, a version refusal, a held delete or a real outage of the restarted session wins over it, and so
does the outage banner, except for a rebuild that left no session behind (nothing retries then, so the
stopped row is the whole answer). A stop keeps its reason until the next resync, a lock or a leave, and
the persisted marker brings it back on the next reload or unlock. A failed head list reads as
`1 file could not be downloaded.` / `N files could not be downloaded.`, with the engine's own message
(and its path hashes) left in the log; any other reason longer than 96 characters is cut. Progress
publishing is throttled to about four renders a second, with the first and last count always shown, and
the palette joins a run already in flight instead of starting a second one. A run reports only to the
session epoch it started in, bumped by `disposeRuntime` (a lock, a leave, an unload, a re-key lock) and
by `startUnlockedSession` (a re-key finish, a join, a new server address). The rebuild's own teardown and
its recovery restart pass `keepEpoch`, so its run keeps reporting through them: a late settle cannot land
in the next session. A rejoin shows the same running surfaces but keeps its own failure answer: the pause and its
notice.

**Modals & views**: setup wizard, passphrase/forgot, config scope, folders, conflicts, trash, history
(view + modal), activity, mass-delete review, re-key, rename vault, server address, export.

**Conflicts** (`ui/conflicts-modal.ts` + `conflict-review-modal.ts`, logic in the `obsidian`-free
`conflict-review-view.ts`): the list row is the file name over its folder with Review and Open both.
Review compares the original (server copy) with the set aside conflict file line by line: shared
lines plain, a version's own lines in that version's colour with a margin bar, the two names as the
key. Each key carries the device and the time that side wrote: the original the server head
version's device and time, the conflict file its own mtime (`conflict-list.ts`). `ui/line-diff.ts` is the one
line alignment, shared with the history diff. When both sides hold the
same content the window says so (`ConflictRow.sameContent`), sizes itself to its content, and offers
Remove conflict and Back only. Keep original and Keep conflict name the files; which `keep-mine`/`keep-theirs` they run
inverts with `conflictFileIsMine`. The button, its confirm, its notice and the activity line use the
same words.
Binaries keep their thumbnails and in row keep actions.

**History window** (`ui/history-modal.ts` + `history-pane.ts`): a click redraws only what it
changed. Opening or closing a day rebuilds the list; selecting a version, the list and the preview;
Changes, the preview; device names landing, the list, the subtitle and the caption text. Only a
load, a retry, a restore or the phone switching panes rebuilds the window. The list is 40% wide and
never shrinks, so a version's content cannot take width from it.

**History labels** (`ui/history-periods.ts`, `ui/history-view.ts`, `obsidian`-free): a deletion and
a trash restore are rows of their own between the editing periods, like the rename marker:
`Today 14:06 · Deleted on <device>`, `Today 14:08 · Restored from trash on <device>`. A row is one
line, cut with an ellipsis. A restore row is a saved version: it selects and previews, carries a
trailing chevron, and its preview caption reads the row's own words (`Restored from trash on
<device> · 14:08`). A deletion row has no content: no chevron, and a tap only expands the line it
cut off. A name the vault never saw (a version the retired pseudo device authored, a revoked device)
leaves its row bare: `Deleted`, `Restored from trash`.

**History on the phone** (`manifest/styles.css`, `.is-phone .geode-history-*`): a full-height sheet
as wide as the phone (the desktop sizing no longer overrides it); the rows are `--touch-size-s` tap
targets. One title rule (`#10/#68/#77`) serves every phone modal with a dynamic title: the header
reserves the ✕'s width and `.modal-title` drops Obsidian's nowrap cap and wraps in what is left, so
history, conflict review and the trash preview show the whole file name. The list or the preview
takes the rest of the height (the list scrolls; Back opens the preview), and the two-pane sizing
stays behind `body:not(.is-phone)`.
The code splits the window the way the styles do: `history-view.ts` `singlePane(Platform)` asks
`Platform.isPhone`, not `isMobile`, so a tablet keeps the desktop two-pane window (#24).

**Admin token gate** (`ui/admin-token-modal.ts`): `withAdminToken(host, ask, onOk)` runs a privileged
action with the session's in-memory admin token, prompting for it (validated against the server, never
persisted, asked once per Obsidian session) when it is not cached. A 401 from the action drops the
cached token (`plumbing/errors.ts` `isAdminAuthFailure`), so a token rotated on the server prompts
again instead of failing forever. Two callers: Devices → Revoke, and a trash purge inside the server's
retention floor (#677, `../ops/trash-soft-delete.md` §5).

---

## 10. Mobile

- **Keys**: after the first derivation the three keys are cached in Obsidian's per-device local storage,
  valid for `unlockTimeoutHours`. Later launches skip Argon2. The keys are at rest on the device while
  cached.
- **HTTP**: `fetch` on mobile, `requestUrl` on desktop (§4). Both paths go through `http-platform.ts`.
- **Background**: iOS and Android suspend Obsidian. The socket drops, and the transport's reconnect loop
  reconnects with backoff. There is no background sync and no push.
- **iCloud / Google Drive**: never enable a second sync tool on the vault folder. One sync tool per
  vault.

---

## 11. Module map

| Path | Responsibility |
| --- | --- |
| `main.ts` | Plugin class: settings, commands, status bar, delegations to `vault-lock.ts` / `session.ts` |
| `session.ts` | unlocked-session wiring: state, transport, sync manager, event handler, status reporting |
| `plumbing/settings-types.ts` | `PluginSettings`, defaults, new-vault params, `isSyncable`, category mapping |
| `plumbing/state.ts`, `state-persistence.ts` | in-memory rows + cursor, JSON persistence, throttle |
| `plumbing/vault-lock.ts`, `key-cache.ts` | unlock/lock/leave, key cache |
| `plumbing/log.ts`, `commands.ts`, `atomic-write.ts`, `bytes.ts`, `errors.ts` | log ring buffer, palette commands, file helpers |
| `plumbing/http-platform.ts`, `scheme.ts`, `server-address.ts`, `server-host.ts` (`ui/`) | transport selection, URL schemes/host handling |
| `plumbing/window.ts` | `windowGlobal`: the renderer's window for timers and the default transport (popout windows need it; Deno tests only have `self`) |
| `plumbing/provisioning-client.ts`, `rekey-client.ts`, `trash-client.ts`, `storage-client.ts`, `scope-pending.ts` | server calls outside the sync core |
| `sync/transport.ts`, `http-client.ts`, `commit-channel.ts`, `commit-queue.ts` | connectivity, HTTP, commit serialization and queueing |
| `sync/events.ts`, `reconciler.ts`, `stale-rows.ts`, `enumerate-disk.ts`, `vault-io.ts` | vault → op translation, full scans, stale-row repair, disk IO |
| `sync/apply.ts`, `replay.ts`, `merger.ts`, `conflict-handler.ts`, `conflicts.ts` | inbound apply, merge, conflict surfacing |
| `sync/commit.ts`, `path-lock.ts`, `rename-*.ts`, `parked-moves.ts` | outbound commits, one-writer-per-path, rename links |
| `sync/history-*.ts`, `export-vault.ts`, `recovery.ts`, `rebuild-flow.ts`, `join-plan.ts`, `rejoin.ts`, `rekey-*.ts` | history, export, resync and rejoin rebuilds, join mode, rejoin backup, re-key |
| `ui/` | settings tab + sections, status bar/menu, modals, views |
| `ui/server-update*.ts`, `plumbing/update-client.ts` | #44: the server update run, its dialog, the Status row's copy, the two HTTP calls |

---

## 12. What the gate verifies

The per-step checks live in `../testing/step-gates.md`. These are the plugin claims of this doc that a
reviewer can check against those gates:

- Two devices converge: an edit on A appears on B; the reconciler catches an external edit and an
  external delete; a reconnect replays from `last_seen_seq` without duplicates; the origin device never
  re-applies its own commit.
- No write loop: the commit is sent at most 2 s after the first edit, and an applied remote version is
  not re-committed (self-write suppression plus the row's identity hash).
- A rename is one marker and one note, never a re-upload. A rename missed while Obsidian was closed is
  paired only on exact 1:1 content, and the mass-delete guard holds everything when it trips.
- The history window keeps the list's width across clicks and keeps the preview when a day opens or
  closes (`test/e2e/scenarios/history-redraw.spec.ts`).
- A conflict never loses a side: the path holds the server copy, the conflict file holds the local one,
  and only a `clean` outcome commits (`merge.md` §6).
- Mobile: a cached-key launch skips Argon2; a resumed app reconnects and reconciles; HTTP goes through
  `fetch` on mobile and `requestUrl` on desktop.
- Phone history fits: the title stays clear of ✕, no row or toolbar button is cut, and the list or the
  preview takes over half the screen height
  (`test/e2e/scenarios/file-history.phone.spec.ts`).
- Tablet history is the desktop window: the list at 40% with the preview beside it, nothing empty on
  the right, no Back button (`test/e2e/scenarios/file-history-tablet.phone.spec.ts`, which runs with
  `GEODE_TABLET=1`).
