import { openStateDB } from "../../../plugin/plumbing/state.ts";

import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";

Deno.test("sync-cursor-persistence - serializeSyncCursor round-trips through openStateDB", () => {
  const db = openStateDB();
  db.updateSyncCursor(42);

  const json = db.serializeSyncCursor();
  const parsed = JSON.parse(json);
  assertEquals(parsed.last_seen_seq, 42);
  db.close();

  const db2 = openStateDB(null, parsed.last_seen_seq);
  assertEquals(db2.getSyncCursor(), 42);
  db2.close();
});

Deno.test("sync-cursor-persistence - setSyncCursorPersist hook fires on updateSyncCursor, unthrottled", async () => {
  const db = openStateDB();

  let captured: string | null = null;
  db.setSyncCursorPersist((json: string) => {
    captured = json;
  });

  db.updateSyncCursor(7);
  await db.drainCursorWrites();

  // The write is queued, never throttled: no debounce wait needed
  assert(captured !== null, "cursor persist hook should have fired without a wait");
  const parsed = JSON.parse(captured!);
  assertEquals(parsed.last_seen_seq, 7);

  db.close();
});

Deno.test("sync-cursor-persistence - close flushes the cursor via the hook", async () => {
  const db = openStateDB();

  let captured: string | null = null;
  db.setSyncCursorPersist((json: string) => {
    captured = json;
  });

  db.updateSyncCursor(99);

  // Close flushes the cursor unconditionally (its write rides the queue).
  db.close();
  await db.drainCursorWrites();

  assert(captured !== null, "close should flush cursor persist");
  const parsed = JSON.parse(captured!);
  assertEquals(parsed.last_seen_seq, 99);
});

// ── last-backup stamp (#134 step 3) ──

Deno.test("sync-cursor-persistence - serializeSyncCursor carries the last-backup stamp", () => {
  const db = openStateDB();
  db.setSyncCursorPersist(() => {});
  const stamp = 1_700_000_000_000;
  assertEquals(db.recordBackup(stamp), stamp);
  const parsed = JSON.parse(db.serializeSyncCursor());
  assertEquals(parsed.last_backup_at, stamp);
  db.close();
});

Deno.test("sync-cursor-persistence - openStateDB seeds the stamp (missing field → 0)", () => {
  const db = openStateDB(null, 42);
  assertEquals(
    JSON.parse(db.serializeSyncCursor()).last_backup_at,
    0,
    "old files without the field load as 0",
  );
  db.close();

  const db2 = openStateDB(null, 42, 1_700_000_000_000);
  const parsed = JSON.parse(db2.serializeSyncCursor());
  assertEquals(parsed.last_backup_at, 1_700_000_000_000);
  db2.close();
});

Deno.test("sync-cursor-persistence - recordBackup applies the next-backup rule and returns it", () => {
  const db = openStateDB(null, 0, 100);
  // A lower stamp never moves the value back (max rule).
  assertEquals(db.recordBackup(50), 100);
  assertEquals(db.recordBackup(250), 250);
  db.close();
});

Deno.test("sync-cursor-persistence - stamp-only writes are throttled to one per 60s", async () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const stamps: number[] = [];
    db.setSyncCursorPersist((json) => {
      stamps.push(JSON.parse(json).last_backup_at);
    });

    db.recordBackup(1);
    await db.drainCursorWrites();
    assertEquals(stamps, [1], "first stamp persists immediately");

    db.recordBackup(2);
    await db.drainCursorWrites();
    assertEquals(stamps, [1], "stamp-only write within 60s is skipped");

    time.tick(60_000);
    db.recordBackup(3);
    await db.drainCursorWrites();
    assertEquals(stamps, [1, 3], "stamp-only write after 60s persists");
    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("sync-cursor-persistence - a cursor advance writes the latest stamp", async () => {
  const db = openStateDB();
  const writes: Array<Record<string, number>> = [];
  db.setSyncCursorPersist((json) => {
    writes.push(JSON.parse(json));
  });

  db.recordBackup(1_700_000_000_000);
  db.advanceSyncCursor(1);
  await db.drainCursorWrites();
  const last = writes[writes.length - 1];
  assertEquals(last.last_seen_seq, 1);
  assertEquals(last.last_backup_at, 1_700_000_000_000, "advance carries the current stamp");
  db.close();
});

Deno.test("sync-cursor-persistence - close writes the latest stamp even when throttled", async () => {
  const db = openStateDB();
  const stamps: number[] = [];
  db.setSyncCursorPersist((json) => {
    stamps.push(JSON.parse(json).last_backup_at);
  });
  db.recordBackup(42);
  await db.drainCursorWrites();
  db.recordBackup(43);
  await db.drainCursorWrites();
  assertEquals(stamps, [42], "second stamp-only write throttled");
  db.close();
  await db.drainCursorWrites();
  assertEquals(stamps, [42, 43], "close flushes the throttled stamp");
});

// ── the interrupted-write record (#59) ──

const ENTRY = { path: "note.md", path_hash: "hash-a", expected_plaintext_hash: "content-a" };

Deno.test("state - a write is recorded before it starts and dropped once it returns", async () => {
  const db = openStateDB();
  const written: unknown[] = [];
  db.setSyncCursorPersist((json) => {
    written.push(JSON.parse(json).in_flight_apply ?? []);
  });

  await db.beginWrite(ENTRY);
  assertEquals(written, [[ENTRY]], "the entry is durable before the write starts");
  assertEquals(db.isTorn("hash-a"), true, "its bytes may be a fragment right now");

  await db.endWrite("hash-a");
  assertEquals(written[written.length - 1], [], "the record is gone once the write returned");
  assertEquals(db.isTorn("hash-a"), false);
  db.close();
});

Deno.test("state - a record read back is torn until the start pass clears it", async () => {
  const db = openStateDB(null, null, null, [ENTRY]);
  assertEquals(db.getInterruptedWrites(), [ENTRY], "the start pass reads it once");
  assertEquals(db.isTorn("hash-a"), true, "the apply must treat its bytes as a fragment");

  await db.clearInterruptedWrites([ENTRY]);
  assertEquals(db.getInterruptedWrites(), []);
  assertEquals(db.isTorn("hash-a"), false, "nothing survives the start that read it");
  db.close();
});

Deno.test("state - a write that cannot be recorded fails closed", async () => {
  const db = openStateDB();
  db.setSyncCursorPersist(() => Promise.reject(new Error("disk full")));

  await assertRejects(() => db.beginWrite(ENTRY), Error, "disk full");
  assertEquals(db.isTorn("hash-a"), false, "a write that could not be recorded claims nothing");
});

Deno.test("state - a slow write keeps its place in the chain, so no stale write lands last", async () => {
  const db = openStateDB();
  const landed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => release = resolve);
  let first = true;
  db.setSyncCursorPersist(async (json) => {
    if (first) {
      first = false;
      await slow; // the bridge is slow on the first write
    }
    landed.push((JSON.parse(json).in_flight_apply ?? []).map((e) => e.path_hash).join(","));
  });

  const begun = db.beginWrite(ENTRY);
  await Promise.resolve();
  // A later write must NOT overtake the slow one: it waits in the chain.
  const next = db.beginWrite({ ...ENTRY, path_hash: "hash-b" });
  await Promise.resolve();
  assertEquals(landed, [], "nothing lands while the first write is unsettled");

  release();
  await Promise.all([begun, next]);
  assertEquals(landed, ["hash-a", "hash-a,hash-b"], "then both land, in order");
  db.close();
});

Deno.test("state - a wedged chain fails later writes at once, not one wait each", async () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    db.setSyncCursorPersist(() => new Promise<void>(() => {})); // the bridge never answers

    const first = db.beginWrite(ENTRY).catch((error) => error);
    await Promise.resolve();
    time.tick(10_000);
    assert(await first instanceof Error, "the first caller waits out the bound and fails closed");

    // A drain of 45 files must not spend 45 waits on a chain that cannot move.
    const second = db.beginWrite({ ...ENTRY, path_hash: "hash-b" }).catch((error) => error);
    const outcome = await second; // no clock tick: it must reject on its own
    assert(outcome instanceof Error, "the next caller fails at once");
    assertEquals((outcome as Error).message.includes("wedged"), true);
    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("state - re-attaching a state lets its writes through again", async () => {
  const db = openStateDB();
  const written: string[] = [];
  db.close();
  db.setSyncCursorPersist((json) => {
    written.push(json);
  });
  // #744/#59: a session that re-attaches a closed state (re-key, resume) writes again.
  await db.beginWrite(ENTRY);
  assertEquals(written.length, 1);
  await db.endWrite("hash-a");
  assertEquals(written.length, 2);
});
