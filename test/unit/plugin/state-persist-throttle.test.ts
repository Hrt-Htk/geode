import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";

/**
 * #328: state-file persistence must coalesce so a cold-sync drain causes
 * O(drain-seconds) adapter.writeBinary calls, not O(files). local-files
 * (previously a 500 ms resetting debounce that fired once per ~600 ms drain
 * file) uses a trailing throttle: the first change arms a timer, in-window
 * changes don't re-arm, the timer fires once writing the CURRENT state, then
 * the next change re-arms. The sync cursor is NOT throttled: it persists
 * immediately on advance (it is ~41 bytes; a stale cursor on crash would
 * replay past an applied edit and lose it). close() flushes the pending
 * local-files write synchronously and nulls both hooks.
 */

const row = (path: string, n: number) => ({
  path,
  path_hash: `h${n}`,
  size: 1,
  mtime: 0,
  plaintext_hash: `p${n}`,
  last_seen_version: 1,
  chunk_hashes: [] as string[],
});

Deno.test("state-persist-throttle - drain-paced upserts produce bounded local-files writes", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const writes: string[] = [];
    db.setPersist((json) => {
      writes.push(json);
    });

    // Simulate the cold-sync drain: a file lands every 600 ms (real ~1.5/s).
    for (let i = 0; i < 7; i++) {
      db.upsertLocalFile(row(`f${i}.md`, i));
      time.tick(600);
    }
    time.tick(2000); // settle any final pending write

    assert(
      writes.length < 7,
      `bounded local-files writes: got ${writes.length} for 7 drain-paced upserts`,
    );
    assert(writes.length > 0, "at least one write must have landed");

    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("state-persist-throttle - cursor persist hook fires synchronously on advance (no throttle)", () => {
  const db = openStateDB();
  const persisted: number[] = [];
  db.setSyncCursorPersist((json) => {
    persisted.push(JSON.parse(json).last_seen_seq);
  });

  db.advanceSyncCursor(1); // contiguous 0 -> 1
  assertEquals(persisted, [1], "cursor persisted synchronously on advance: no timer tick");

  db.advanceSyncCursor(2);
  assertEquals(persisted, [1, 2], "every advance persists immediately");

  db.close();
});

Deno.test("state-persist-throttle - close flushes the pending local-files write", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const writes: string[] = [];
    db.setPersist((json) => {
      writes.push(`local:${JSON.parse(json).length}`);
    });
    db.setSyncCursorPersist((json) => {
      writes.push(`cursor:${JSON.parse(json).last_seen_seq}`);
    });

    db.upsertLocalFile(row("a.md", 1));
    assertEquals(writes.length, 0, "local-files throttled: nothing before the window");

    db.close();
    assert(writes.includes("local:1"), "close flushes the pending local-files write");
  } finally {
    time.restore();
  }
});

Deno.test("state-persist-throttle - a late upsert/cursor after close() writes nothing more", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const writes: string[] = [];
    db.setPersist(() => {
      writes.push("local");
    });
    db.setSyncCursorPersist(() => {
      writes.push("cursor");
    });

    db.upsertLocalFile(row("a.md", 1));
    db.close(); // flushes pending local + writes the cursor, then nulls both hooks

    // A drain still in flight after dispose must not re-arm a timer and write
    // stale state over the next session's files ~2s later.
    db.upsertLocalFile(row("b.md", 2));
    db.advanceSyncCursor(1);
    time.tick(2000);

    assertEquals(
      writes,
      ["local", "cursor"],
      "close writes local+cursor once; late changes write nothing",
    );
  } finally {
    time.restore();
  }
});
