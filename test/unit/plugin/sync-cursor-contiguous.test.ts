import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { assertEquals } from "@std/assert";

/**
 * The persisted sync cursor is the TOP of the contiguous run of seqs durably
 * accounted for (applied / skipped / our own commit), NOT "highest seen". An
 * un-applied seq halts the prefix no matter what completes later, so a transient
 * apply failure can never be skipped past and lost on reconnect (#212).
 *
 * advanceSyncCursor records a durably-accounted seq in a pending set and only
 * flushes the cursor when it can advance contiguously. updateSyncCursor remains
 * the ABSOLUTE setter used by load and recovery (its jump clears the pending set).
 */

function freshDB() {
  return openStateDB();
}

Deno.test("sync-cursor-contiguous - in-order advances to the top", async () => {
  const db = await freshDB();
  db.advanceSyncCursor(1);
  db.advanceSyncCursor(2);
  db.advanceSyncCursor(3);
  assertEquals(db.getSyncCursor(), 3);
  db.close();
});

Deno.test("sync-cursor-contiguous - out-of-order gap holds until the gap is filled", async () => {
  const db = await freshDB();
  db.advanceSyncCursor(1);
  db.advanceSyncCursor(3); // seq 2 still missing
  assertEquals(db.getSyncCursor(), 1);
  db.advanceSyncCursor(2); // gap filled -> flush 1,2,3
  assertEquals(db.getSyncCursor(), 3);
  db.close();
});

Deno.test("sync-cursor-contiguous - never-applied seq halts the prefix forever", async () => {
  const db = await freshDB();
  db.advanceSyncCursor(1);
  db.advanceSyncCursor(3);
  db.advanceSyncCursor(4);
  // seq 2 never arrives -> the persisted cursor must not leap past it.
  assertEquals(db.getSyncCursor(), 1);
  db.close();
});

Deno.test("sync-cursor-contiguous - absolute set jumps and clears pending", async () => {
  const db = await freshDB();
  db.advanceSyncCursor(5); // pending {5}, cursor stays 0 (no contiguous run from 1)
  assertEquals(db.getSyncCursor(), 0);
  db.updateSyncCursor(10); // load/recovery jump: absolute set, clears pending
  assertEquals(db.getSyncCursor(), 10);
  db.advanceSyncCursor(11); // contiguous from 10
  assertEquals(db.getSyncCursor(), 11);
  // A late advance below the cursor is a no-op: the stale pending 5 was cleared
  // by the absolute jump and cannot resurrect / move the cursor.
  db.advanceSyncCursor(5);
  assertEquals(db.getSyncCursor(), 11);
  db.close();
});

Deno.test("sync-cursor-contiguous - persist fires only when the cursor actually advances", async () => {
  const db = await freshDB();
  let persists = 0;
  db.setSyncCursorPersist(() => persists++);

  db.advanceSyncCursor(1); // cursor 0 -> 1
  assertEquals(persists, 1);

  db.advanceSyncCursor(3); // gap at 2: no cursor change, no persist
  db.advanceSyncCursor(4); // still gapped at 2: no cursor change, no persist
  assertEquals(persists, 1);

  db.advanceSyncCursor(2); // 2,3,4 flush in one step
  assertEquals(persists, 2);
  assertEquals(db.getSyncCursor(), 4);

  db.close();
});

// #369: compaction deletes old rows server-side, leaving seq gaps. The server
// replays ascending and sends every EXISTING seq, so a seq that was never
// received AND is below a received (higher) seq is a permanent compaction gap the
// server will never resend: the cursor may skip it. noteReceived records which
// seqs the server actually streamed, so a received-but-un-applied seq still halts.

Deno.test("sync-cursor-contiguous - compaction gap (never received, server streamed past) is skipped", async () => {
  const db = await freshDB();
  db.beginReplay(3);
  db.noteReceived(1);
  db.noteReceived(3); // replay end received; server streamed past the compacted-away 2
  db.advanceSyncCursor(1); // cursor -> 1
  db.advanceSyncCursor(3); // 2 confirmed gone -> cursor 3
  assertEquals(db.getSyncCursor(), 3);
  db.close();
});

Deno.test("sync-cursor-contiguous - run of consecutive gaps all skipped to the received top", async () => {
  const db = await freshDB();
  db.beginReplay(5);
  db.noteReceived(5); // replay end received -> replay complete; 1..4 never received
  db.advanceSyncCursor(5); // 1..4 never received -> all skipped
  assertEquals(db.getSyncCursor(), 5);
  db.close();
});

Deno.test("sync-cursor-contiguous - received-but-un-applied seq still halts across a gap", async () => {
  const db = await freshDB();
  db.beginReplay(3);
  db.noteReceived(1);
  db.noteReceived(2); // seq 2 was received but its apply will fail
  db.noteReceived(3);
  db.advanceSyncCursor(1); // cursor -> 1
  db.advanceSyncCursor(3); // 2 was received -> must NOT be skipped as a gap
  assertEquals(db.getSyncCursor(), 1);
  db.advanceSyncCursor(2); // gap heals -> flush 2,3
  assertEquals(db.getSyncCursor(), 3);
  db.close();
});
