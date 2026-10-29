import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { assert, assertEquals } from "@std/assert";
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

Deno.test("sync-cursor-persistence - setSyncCursorPersist hook fires eagerly on updateSyncCursor", () => {
  const db = openStateDB();

  let captured: string | null = null;
  db.setSyncCursorPersist((json: string) => {
    captured = json;
  });

  db.updateSyncCursor(7);

  // Hook fires synchronously: no debounce wait needed
  assert(captured !== null, "cursor persist hook should have fired immediately");
  const parsed = JSON.parse(captured!);
  assertEquals(parsed.last_seen_seq, 7);

  db.close();
});

Deno.test("sync-cursor-persistence - close flushes the cursor via the hook", () => {
  const db = openStateDB();

  let captured: string | null = null;
  db.setSyncCursorPersist((json: string) => {
    captured = json;
  });

  db.updateSyncCursor(99);

  // Close should flush the cursor unconditionally
  db.close();

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

Deno.test("sync-cursor-persistence - stamp-only writes are throttled to one per 60s", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const stamps: number[] = [];
    db.setSyncCursorPersist((json) => {
      stamps.push(JSON.parse(json).last_backup_at);
    });

    db.recordBackup(1);
    assertEquals(stamps, [1], "first stamp persists immediately");

    db.recordBackup(2);
    assertEquals(stamps, [1], "stamp-only write within 60s is skipped");

    time.tick(60_000);
    db.recordBackup(3);
    assertEquals(stamps, [1, 3], "stamp-only write after 60s persists");
    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("sync-cursor-persistence - a cursor advance writes the latest stamp", () => {
  const db = openStateDB();
  const writes: Array<Record<string, number>> = [];
  db.setSyncCursorPersist((json) => {
    writes.push(JSON.parse(json));
  });

  db.recordBackup(1_700_000_000_000);
  db.advanceSyncCursor(1);
  const last = writes[writes.length - 1];
  assertEquals(last.last_seen_seq, 1);
  assertEquals(last.last_backup_at, 1_700_000_000_000, "advance carries the current stamp");
  db.close();
});

Deno.test("sync-cursor-persistence - close writes the latest stamp even when throttled", () => {
  const db = openStateDB();
  const stamps: number[] = [];
  db.setSyncCursorPersist((json) => {
    stamps.push(JSON.parse(json).last_backup_at);
  });
  db.recordBackup(42);
  db.recordBackup(43);
  assertEquals(stamps, [42], "second stamp-only write throttled");
  db.close();
  assertEquals(stamps, [42, 43], "close flushes the throttled stamp");
});
