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

// ── interrupted downloads (#59) ──

Deno.test("sync-cursor-persistence - a batch is durable before its first write, cleared per path", async () => {
  const db = openStateDB();
  const written: string[][] = [];
  db.setSyncCursorPersist((json) => {
    written.push(JSON.parse(json).in_flight_apply ?? []);
  });

  // One write for the whole batch, before the first file write.
  await db.beginApply(["hash-a", "hash-b"]);
  assertEquals(written, [["hash-a", "hash-b"]], "beginApply flushes the batch once");
  assertEquals(db.getInFlightApply(), ["hash-a", "hash-b"]);

  // Only a path whose download landed is cleared: a failed, deferred or headless one stays.
  await db.endApply(["hash-a"]);
  assertEquals(db.getInFlightApply(), ["hash-b"]);
  assertEquals(written[written.length - 1], ["hash-b"], "the record names the unfinished path");

  await db.endApply(["hash-b"]);
  assertEquals(db.getInFlightApply(), []);
  assertEquals(written[written.length - 1], [], "the finished batch leaves no record");
});

Deno.test("sync-cursor-persistence - a path read back from the last session is interrupted", async () => {
  const db = openStateDB(null, null, null, ["hash-old"]);
  assertEquals(db.getInterruptedApply(), ["hash-old"], "its bytes may be a fragment");
  assertEquals(db.isInterrupted("hash-old"), true);
  assertEquals(db.isInterrupted("hash-now"), false);

  await db.beginApply(["hash-now"]);
  assertEquals(
    db.isInterrupted("hash-now"),
    false,
    "this session's own batch is not a fragment: the apply decides divergence itself",
  );
  assertEquals(db.getInFlightApply(), ["hash-old", "hash-now"], "both are off limits to a pass");

  // A version that was deferred or out of scope wrote nothing: it stops blocking a pass
  // but stays owed in the record for the next start.
  await db.beginApply(["hash-deferred"]);
  db.releaseWrite("hash-deferred");
  assertEquals(db.isWriting("hash-deferred"), false, "nothing was written, nothing to block");
  assertEquals(db.getInFlightApply(), ["hash-old", "hash-now", "hash-deferred"], "still owed");

  await db.endApply(["hash-old"]);
  assertEquals(db.isInterrupted("hash-old"), false);
  assertEquals(
    db.getInFlightApply(),
    ["hash-now", "hash-deferred"],
    "this session's batch is still owed",
  );
  db.close();
});

Deno.test("sync-cursor-persistence - a record that cannot be written fails closed", async () => {
  const db = openStateDB();
  db.setSyncCursorPersist(() => Promise.reject(new Error("disk full")));

  await assertRejects(() => db.beginApply(["hash-a"]), Error, "disk full");
  assertEquals(db.getInFlightApply(), [], "a batch that could not be recorded claims nothing");

  // Clearing is best effort: a leftover record is safe, the next start would re-apply it.
  await db.endApply(["hash-a"]);
});

Deno.test("sync-cursor-persistence - a slow cursor write cannot resurrect a cleared record", async () => {
  const db = openStateDB();
  const landed: string[] = [];
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => release = resolve);
  let first = true;
  db.setSyncCursorPersist(async (json) => {
    if (first) {
      first = false;
      await stalled; // the disk is busy on the first write
    }
    landed.push((JSON.parse(json).in_flight_apply ?? []).join(","));
  });

  const begun = db.beginApply(["hash-a"]);
  const cleared = db.endApply(["hash-a"]);
  release();
  await Promise.all([begun, cleared]);

  const finishedAt = landed.findIndex((entry) => entry === "");
  assert(finishedAt >= 0, `the clearing write landed: ${JSON.stringify(landed)}`);
  assert(
    !landed.slice(finishedAt).some((entry) => entry !== ""),
    `a cleared record never comes back: ${JSON.stringify(landed)}`,
  );
  assertEquals(db.getInFlightApply(), []);
});

Deno.test("sync-cursor-persistence - a cursor write that never answers does not hold the queue", async () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const landed: string[] = [];
    let hang = true;
    db.setSyncCursorPersist((json) => {
      if (hang) return new Promise<void>(() => {}); // the bridge stops answering
      landed.push(json);
    });

    const begun = db.beginApply(["hash-a"]).catch((error) => error);
    await Promise.resolve();
    time.tick(10_000);
    const error = await begun;
    assert(error instanceof Error, "the batch fails closed instead of waiting forever");

    // The queue moved on: the next batch records, and the cursor keeps being written.
    hang = false;
    await db.beginApply(["hash-a"]);
    assertEquals(JSON.parse(landed.at(-1)!).in_flight_apply, ["hash-a"]);
    db.close();
  } finally {
    time.restore();
  }
});
