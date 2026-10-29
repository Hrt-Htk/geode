import { type CompactRow, planCompaction } from "../../../core/compact.ts";
import { assertEquals } from "@std/assert";

// Deterministic harness: floor = now - floorMs; dayKey groups by a floor-relative bucket.
const NOW = 1_000_000;
const FLOOR_MS = 100_000;
const RECENT = NOW - FLOOR_MS; // >= this => recent

function dayKey(ts: number): string {
  if (ts < 150) return "A"; // versions 1,2
  if (ts < 300) return "B"; // versions 3,4
  return "C";
}

Deno.test("compact - root and head always kept even when old", () => {
  const rows: CompactRow[] = [1, 2, 3, 4, 5, 6, 7].map((v) => ({
    version: v,
    created_at: 100, // all old, same day
  }));
  const plan = planCompaction(rows, NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(plan.keep.includes(1), true);
  assertEquals(plan.keep.includes(7), true);
  assertEquals(plan.drop, [2, 3, 4, 5, 6]);
  assertEquals(plan.ranges, [{ version: 7, label: "2-7" }]);
});

Deno.test("compact - recent (<30d) versions are all kept", () => {
  const rows: CompactRow[] = [1, 2, 3, 4].map((v) => ({
    version: v,
    created_at: RECENT + 1,
  }));
  const plan = planCompaction(rows, NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(plan.keep, [1, 2, 3, 4]);
  assertEquals(plan.drop, []);
  assertEquals(plan.ranges, []);
});

Deno.test("compact - old folds to last-of-day, recent + root + head kept", () => {
  const rows: CompactRow[] = [
    { version: 1, created_at: 100 }, // old, root, day A
    { version: 2, created_at: 100 }, // old, day A (kept: last of A)
    { version: 3, created_at: 200 }, // old, day B (dropped)
    { version: 4, created_at: 200 }, // old, day B (kept: last of B)
    { version: 5, created_at: RECENT + 1 }, // recent, head
  ];
  const plan = planCompaction(rows, NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(plan.keep, [1, 2, 4, 5]);
  assertEquals(plan.drop, [3]);
  assertEquals(plan.ranges, [{ version: 4, label: "3-4" }]);
});

Deno.test("compact - idempotent: second pass drops nothing and emits no ranges", () => {
  const rows: CompactRow[] = [
    { version: 1, created_at: 100 },
    { version: 2, created_at: 100 },
    { version: 3, created_at: 200 },
    { version: 4, created_at: 200 },
    { version: 5, created_at: RECENT + 1 },
  ];
  const first = planCompaction(rows, NOW, { floorMs: FLOOR_MS, dayKey });
  const surviving = rows.filter((r) => first.keep.includes(r.version));
  const second = planCompaction(surviving, NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(second.drop, []);
  assertEquals(second.ranges, []);
  assertEquals(second.keep, first.keep);
});

Deno.test("compact - rename marker and note rows are never dropped (#583)", () => {
  // Interior rows: root and head would be enough for the old plan, so only the
  // rename_mark keep-set saves 3 (marker) and 4 (note).
  const rows: CompactRow[] = [1, 2, 3, 4, 5, 6, 7].map((v) => ({
    version: v,
    created_at: 100,
    rename_mark: v === 3 ? 1 : v === 4 ? 2 : 0,
  }));
  const plan = planCompaction(rows, NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(plan.keep, [1, 3, 4, 7]);
  assertEquals(plan.drop, [2, 5, 6]);
});

Deno.test("compact - single row keeps it, no drops or ranges", () => {
  const plan = planCompaction([{ version: 42, created_at: 0 }], NOW, {
    floorMs: FLOOR_MS,
    dayKey,
  });
  assertEquals(plan.keep, [42]);
  assertEquals(plan.drop, []);
  assertEquals(plan.ranges, []);
});

Deno.test("compact - default day key groups by UTC date, not host-local", () => {
  // Three versions straddling the UTC midnight 2026-01-01T23:59Z / 01-02T00:00Z.
  // On a UTC+2 host, local dates for all three are the same day (01-02), so a
  // local-TZ day key folds v1 away. UTC keying splits them across two days and
  // must keep v1 (last edit of 01-01).
  const v0 = 1_767_304_800_000; // 2026-01-01T22:00Z
  const v1 = 1_767_310_200_000; // 2026-01-01T23:30Z
  const v2 = 1_767_313_800_000; // 2026-01-02T00:30Z
  const now = 1_767_398_400_000; // 2026-01-03T00:00Z
  const rows: CompactRow[] = [
    { version: 1, created_at: v0 },
    { version: 2, created_at: v1 },
    { version: 3, created_at: v2 },
  ];
  const plan = planCompaction(rows, now, { floorMs: 0 });
  // All three are old (created_at < now); UTC day buckets are {01-01: v2} and
  // {01-02: v3}, so v2 is the last edit of 01-01 and must survive folding.
  assertEquals(plan.keep, [1, 2, 3]);
  assertEquals(plan.drop, []);
});

Deno.test("compact - empty input yields empty plan", () => {
  const plan = planCompaction([], NOW, { floorMs: FLOOR_MS, dayKey });
  assertEquals(plan.keep, []);
  assertEquals(plan.drop, []);
  assertEquals(plan.ranges, []);
});
