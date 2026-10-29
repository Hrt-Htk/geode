---
covers: [plugin/sync/merger.ts, plugin/sync/conflict-handler.ts, plugin/sync/conflicts.ts, plugin/sync/conflict-list.ts, plugin/sync/conflict-resolve.ts]
---

# 3-way merge

**Depends on:** `../crypto/encryption-chunking.md` (reassembly + integrity), `plugin.md` (transport,
state, apply path).

A wrong merge loses user edits, so this doc is the spec for the merge rules. Change the code and this doc
together.

Code lives in `plugin/sync/merger.ts` (merge and surfacing) and `plugin/sync/conflict-handler.ts` (retry
budget and the entry point from a rejected commit).

---

## 1. Types

```ts
export type MergeInput = {
  pathHash: string;
  path: string;
  mime: string;
  local: Uint8Array;              // L
  localVersion: number | null;    // the version L is parented on (null = unknown)
  carried?: boolean;              // #583: the row was carried across a rename, so there is no base
  serverVersion: ServerVersion;    // R (full record)
};

export type MergeOutcome =
  | { kind: "clean"; merged: Uint8Array; commitParent: number; serverPlaintextHash: string }
  | { kind: "conflict_file"; serverContent: Uint8Array; localContent: Uint8Array; reason: string }
  | { kind: "no_op" };
```

`serverPlaintextHash` lets the caller recognize a merge that reproduced R exactly (state update, no
commit). `MergeDeps` is `transport`, `keys`, `state`, `vault` (presence checks) and `deviceId` (the #549
fallback).

---

## 2. End-to-end conflict flow

Entered when a commit is rejected with `server_conflict`, or when an inbound version lands on a path with
local edits (`conflict-handler.ts`):

```
resolveConflict(path, head):
  take the path lock                      # one writer per path, §8 of plugin.md
  retries = retries + 1
  if retries > MAX_RETRIES (5):
      surface a conflict file (server copy to the path, local copy beside it) and stop
  fetch R's head record                   # cached per (path_hash, version), else from the server
  if the row already tracks head.version: return        # a newer resolution owns it (#589/#590)
  if head is a rename marker, or a tombstone with the file gone:
      resolveRemoteClose(head)                          # #583/#361: never resurrect
  if this device already renamed the path away: return  # the pending marker carries the edit
  outcome = merge({ …local bytes…, serverVersion: head })
  "clean":           write the merged bytes; commit them (parent = commitParent), or just
                     update the row when the merge equaled R
  "conflict_file":   surface the conflict file (§6)
  "no_op":           update the row (or keep the row closed for a tombstone, #590)
```

Two resolutions of one path never run at the same time: `handleConflict` serializes them per path, and a
queued one re-reads the head because the running one may have moved past it.

The retry counter caps merge → commit → conflict recursion. It is cleared once a resolution lands, so
independent successive conflicts never accumulate toward it (#124).

---

## 3. The merge function

`merge()` in `merger.ts`, in order:

1. Decrypt R's metadata.
2. **R is deleted.** Local bytes still on disk are an edit against the tombstone, so they win
   (`clean(local)`, parent = R's version). Only a device that also closed the row and has no local bytes
   is a `no_op` (#590).
3. Reassemble R.
4. **Local row closed.** If the file is really absent, `clean(R)`. A file that is back on disk is a
   create over a tombstone: presence, not bytes, decides (an Android adapter still answers a read for a
   file it just removed, and a re-created file can be empty), so it is treated as a re-creation
   (#589/#590).
5. **Identical content** (`blake3(local) == R.plaintext_hash`): `no_op`.
6. **No base** (`carried` or re-creation): `noBaseOutcome`. If the remote still equals the row's base
   hash, the local edit wins (`clean(local)`); otherwise both sides changed, so
   `conflict_file("no_common_ancestor")`.
7. **Find the ancestor** (§4). None gives `noBaseOutcome`.
8. **Dispatch on mime.** `text/markdown` and `text/plain` go to `mergeText` (§5); every other type gives
   `conflict_file("binary_conflict")` with R canonical.

---

## 4. Ancestor walk (`findAncestor`)

The merge base is the **most recent version on R's chain that is ≤ the local parent**:

```ts
const chain = await deps.transport.getVersionChain(pathHash, serverVersion);
let target = localVersion === null
  ? chain.find((v) => v.device_id === deps.deviceId)   // #549: no row (killed inside the
                                                       // persist window) → this device's newest
  : chain.find((v) => v.version <= localVersion);       // otherwise the first ≤ local parent
if (target === undefined) return null;                 // → no_common_ancestor
return await readVersionBytes(target, …);              // null when the row is a delete
```

**Why this works**: the server enforces one monotonic version per path, so the first chain entry with
`version <= localVersion` is the version this device last synced, which is an ancestor of both sides. The
client calls `getVersionChain` once, with no pagination (`before`).

**Limits** (the walk can miss the true ancestor):

- **Chain window of 100.** `server/db.ts` returns at most 100 rows, newest first
  (`ORDER BY version DESC LIMIT 100`). If more than 100 versions landed between the local parent and the
  head, no entry qualifies, which ends in `no_common_ancestor`.
- **Compaction.** Versions older than 30 days (`GEODE_COMPACT_FLOOR_DAYS`) fold into one checkpoint per
  calendar day; root and head are always kept (`core/compact.ts`, `server/compaction.ts`). If the local
  parent was dropped, the walk returns the nearest surviving older checkpoint, which is an older base
  than the true ancestor.
- A delete row carries no content, so it is never a usable base (`readVersionBytes` returns null).

Nothing is cached between merges: every merge does one `getVersionChain` round trip.

---

## 5. Text merge (`mergeText`)

Two passes:

1. **Line-level diff3**: `diff3Merge(L.split("\n"), A.split("\n"), R.split("\n"))`. If no region
   conflicts, that is the merge.
2. **Word-level fallback, per conflicting hunk**: diff3 over the hunk's words and whitespace runs
   (`text.match(/\s+|\S+/g)`) instead of characters, spliced back into the line structure.

Word granularity, not character granularity: a character-level region can "cleanly" fuse two devices'
independent edits of the same word into a third token and drop both (#611; fuzz seed 201 with base
`RN0-1`, local `RN1-17`, remote `RN0-21` produced `RN1-217`). A clean word-level region only ever joins
whole words.

A hunk that still conflicts (`merge_conflict_markers`), or whose three sides exceed `HUNK_MAX_LENGTH`
(2048 chars, which bounds the per-hunk diff cost, #385), aborts the whole merge to `conflict_file`
(`conflict_too_large`). Inputs are BOM-stripped and CRLF-normalized to LF before diffing.

No marker is ever produced. A `conflict_file` outcome means R becomes canonical and L is preserved as the
conflict file; only `outcome.kind === "clean"` ever commits (CLAUDE.md rule 6).

**Why no marker file**: a merged file with conflict markers is what neither side wants. Both originals
are preserved and the user resolves; committing markers would leave a truth that is neither device's.

---

## 6. Conflict file naming (`plugin/sync/conflicts.ts`)

```ts
generateConflictPath(originalPath, deviceName, ts = new Date(), n = 0): string
// "Notes/a.md" → "Notes/a (conflict Laptop 2026-10-12 140205).md"
```

- The marker carries the device writing the conflict file (sanitized: `\/:*?"<>|` replaced with a space,
  whitespace collapsed, capped at 40 chars, blank becomes `This device`), the local date and `HHMMSS`.
- A uniqueness counter inside the marker (`… 140205 2)`) keeps a second conflict generated in the same
  second from overwriting the first.
- **Extension preserved**: `a.md (conflict …)` would break Obsidian's markdown handling.
- `isConflictPath`, `originalPathOf` and `conflictDeviceName` also recognize the legacy
  `.conflict-<iso>` form, because disks and servers already hold such files.
- A **re-surface of the same conflict** (a merge retry) finds identical content in the existing file and
  reuses it instead of stacking a sibling. The comparison uses the normalized markdown identity, so a
  CRLF/LF difference still counts as the same conflict.

Surfacing (`surfaceConflict`) orders the writes: the local copy first, then the server copy over the
path, so a crash in between never loses local content. The row then records R's version, so the next
reconcile does not re-commit L over the head (#367).

Conflict files **sync** like any other vault file and are **never auto-deleted**. The user resolves them
and deletes them. One exception: a conflict copy inside `Geode backup/` (a rejoin's set-aside folder,
`plugin.md` §7a) is history: the conflicts list and its count skip it, because nothing syncs it and no
action applies to it.

---

## 7. Edge case table (authoritative)

| Case | Detection | Outcome |
| --- | --- | --- |
| **Identical content** | `blake3(L) == R.plaintext_hash` | `no_op` |
| **Both closed the row, nothing on disk** | R deleted + local row closed + no local bytes | `no_op` |
| **R deleted, local file still on disk** | R deleted, local bytes exist | `clean(L)`, the edit wins (#361) |
| **R live, local row closed and file gone** | local row closed, file absent | `clean(R)` |
| **Re-created over a tombstone** | local row closed, file present | `noBaseOutcome` (#589/#590) |
| **Carried across a rename** | `input.carried` | `noBaseOutcome` (#583) |
| **No common ancestor** | walk returns null | `conflict_file` |
| **Clean text merge** | every diff3 region resolves | `clean(merged)` |
| **Conflicting text merge** | a hunk still conflicts at word level | `conflict_file` |
| **Hunk too large** | hunk side > 2048 chars | `conflict_file("conflict_too_large")` |
| **Binary conflict** | mime is neither text type | `conflict_file("binary_conflict")` |
| **Retry budget spent** | more than 5 resolutions on one path | `conflict_file("retry_limit")` + warning |

---

## 8. What we deliberately do NOT do

- **Similarity-based rename detection.** Renames are linked by markers and notes (#583) and by the
  reconciler's exact-content pairing (`plugin.md` §6), never by guesswork.
- **Smart merge for `.canvas` / `.excalidraw`**: JSON with graph semantics, where a line diff produces
  garbage, so they take the binary path.
- **Structured 3-way merge for YAML frontmatter**: treated as plain text.
- **Whitespace-aware merging**: whitespace differences are left alone.
- **Auto-resolution of conflict files**: never. This is user-driven only.

---

## 9. Testing this module

These scenarios must be covered:

1. **Two devices edit different lines of the same markdown file**: clean merge, both edits present.
2. **Two devices edit the same line**: conflict file, both edits preserved, no markers written.
3. **Two devices rewrite the same word on one line**: conflict file, both edits kept, never spliced into
   a third token (#611).
4. **Device A appends, device B prepends**: clean merge.
5. **Device A deletes the file, device B edits it**: device B's edit wins, no conflict file.
6. **Both devices create the same new path with different content**: conflict file.
7. **Same plaintext on both sides**: `no_op`, no spurious commit.
8. **Binary conflict**: R wins, L is saved as `… (conflict <device> <ts>).ext`.
9. **Three devices ping-pong**: converges; the retry cap is logged and enforced.
10. **The chain no longer contains the local parent**: conflict file plus an error log.
11. **A clean merge that equals R**: recognized as no spurious commit cycle.

Scenarios run against `test/two-vault-driver.ts` (see `../testing/strategy.md` §2). The on-disk
convergence and real-Obsidian E2E checks are in `../testing/step-gates.md` §Gate 5.

---

## 10. What the gate verifies

- Every row of the §7 table produces its documented outcome (unit tests over `merge()`).
- `findAncestor` returns the right base for chains of length 1, 5 and 50, and the #549 fallback when the
  local row is missing.
- Conflict names preserve the extension and embed the device and timestamp; the legacy form is still
  recognized.
- A marker-containing merge result is never committed (only `outcome.kind === "clean"` commits).
- Two-vault scenarios converge byte-for-byte on disk; the retry cap logs and stops.
