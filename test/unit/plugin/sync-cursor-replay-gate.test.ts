import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { assertEquals } from "@std/assert";

/**
 * #369: the server registers a connection BEFORE the paced replay (ws-handshake),
 * so a LIVE broadcast of a new highest seq can arrive mid-replay. That live seq
 * raises maxReceived, and the old cursor rule skipped every never-received seq
 * below it: persisting the cursor past replayed seqs still in flight. A drop
 * before those lower seqs arrived then lost them permanently.
 *
 * The fix records the replay end per connection (beginReplay, from hello_ack's
 * current_seq) and lets the cursor skip a never-received seq ONLY once the replay
 * is complete (current_seq itself received) and the seq is ≤ that current_seq.
 * receivedSeqs / the completion marker are reset per connection so stale state
 * never carries over.
 */

function freshDB() {
  return openStateDB();
}

// (a) A live seq above the replay end must not let the cursor skip the in-flight
// replay tail. Replay end 100, live 101 received first, 51..100 still streaming:
// the cursor must hold at 50 until they arrive.
Deno.test("sync-cursor-replay-gate - live seq above replay end cannot skip the in-flight replay tail", async () => {
  const db = await freshDB();
  db.updateSyncCursor(50);
  db.beginReplay(100); // hello_ack current_seq
  db.noteReceived(101); // live broadcast races in mid-replay
  db.advanceSyncCursor(101); // sunk/applied, but 51..100 are still in flight
  assertEquals(db.getSyncCursor(), 50, "must not skip past the in-flight replay tail");
  for (let s = 51; s <= 100; s++) db.noteReceived(s);
  for (let s = 51; s <= 100; s++) db.advanceSyncCursor(s);
  db.advanceSyncCursor(101);
  assertEquals(db.getSyncCursor(), 101, "tail received + applied -> cursor reaches the live seq");
  db.close();
});

// (b) A genuine compaction gap (2,3 never sent by the server) is skipped once the
// replay end (4) is actually received.
Deno.test("sync-cursor-replay-gate - genuine compaction gap skipped once the replay end is received", async () => {
  const db = await freshDB();
  db.updateSyncCursor(1);
  db.beginReplay(4); // server current_seq = 4
  db.noteReceived(4); // replay end received; 2,3 were never sent
  db.advanceSyncCursor(4);
  assertEquals(db.getSyncCursor(), 4, "genuine gap 2,3 skipped");
  db.close();
});

// (c) Stale received state from a previous connection must not cause a skip on
// the next one: beginReplay resets receivedSeqs and the completion marker.
Deno.test("sync-cursor-replay-gate - stale received state does not carry into the next connection", async () => {
  const db = await freshDB();
  db.updateSyncCursor(1);
  // Connection 1: replay end 100 received (replay completes), but only 2,3 are
  // applied before the socket drops: 4..100 were streamed but never applied.
  db.beginReplay(100);
  db.noteReceived(2);
  db.advanceSyncCursor(2);
  db.noteReceived(3);
  db.advanceSyncCursor(3);
  db.noteReceived(100); // replay end received -> conn-1 replay complete
  assertEquals(db.getSyncCursor(), 3);
  // Connection 2 (server grew to 150): beginReplay must clear conn-1's completion
  // marker and received set. A stale `replayComplete` would let a live 200 skip
  // the not-yet-replayed tail 4..150.
  db.beginReplay(150);
  db.noteReceived(200); // live broadcast races in mid-replay
  db.advanceSyncCursor(200);
  assertEquals(
    db.getSyncCursor(),
    3,
    "stale conn-1 completion must not let 200 skip the replayed tail",
  );
  // The tail replays; once the new replay end (150) is received, it applies.
  for (let s = 4; s <= 150; s++) db.noteReceived(s);
  for (let s = 4; s <= 150; s++) db.advanceSyncCursor(s);
  assertEquals(
    db.getSyncCursor(),
    150,
    "conn-2 tail received + applied -> nothing lost across the reconnect",
  );
  db.close();
});
