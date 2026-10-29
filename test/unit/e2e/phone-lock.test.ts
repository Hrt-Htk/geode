// Unit tests for the phone-lock sidecar format + status output (#496), the
// ancestor-lock walk (#500), and the FIFO wait/status text + ETA (#508). Pure
// parts only: acquiring the actual flock needs a phone/real contention.

import { assertEquals } from "@std/assert";
import {
  acquirePhoneLock,
  etaMinutes,
  findLockAncestor,
  formatQueue,
  formatStatus,
  isPidAlive,
  parseHolder,
  type ProcReader,
  serializeHolder,
  waitLine,
} from "../../../test/e2e/phone-lock.ts";

const LOCK = "/tmp/geode-phone.lock";

function fakeProc(ppids: Record<number, number>, fds: Record<number, string[]>): ProcReader {
  return {
    ppidOf: (pid) => (pid in ppids ? ppids[pid] : null),
    fdTargets: (pid) => (pid in fds ? fds[pid] : null),
  };
}

const HOLDER = { worktree: "chore-issue496-phone-queue", pid: 1234, startTime: 1_700_000_000_000 };

Deno.test("serializeHolder/parseHolder round-trips", () => {
  assertEquals(parseHolder(serializeHolder(HOLDER)), HOLDER);
});

Deno.test("parseHolder keeps optional progress fields", () => {
  assertEquals(
    parseHolder(serializeHolder({ ...HOLDER, project: "phone", done: 3, total: 21 })),
    { ...HOLDER, project: "phone", done: 3, total: 21 },
  );
});

Deno.test("parseHolder rejects malformed sidecars", () => {
  assertEquals(parseHolder("not json"), null);
  assertEquals(parseHolder("{}"), null);
  assertEquals(parseHolder("[]"), null);
  assertEquals(parseHolder('{"worktree":"x","pid":"a","startTime":1}'), null);
  assertEquals(parseHolder('{"worktree":7,"pid":1,"startTime":1}'), null);
  assertEquals(parseHolder('{"worktree":"x","pid":1,"startTime":"now"}'), null);
});

Deno.test("formatStatus: free", () => {
  assertEquals(formatStatus(null), "phone lock: free");
});

Deno.test("formatStatus: held shows worktree, pid and duration", () => {
  assertEquals(
    formatStatus(HOLDER, 1_700_000_035_000),
    "phone lock: held by chore-issue496-phone-queue (pid 1234) for 0m35s",
  );
  assertEquals(
    formatStatus(HOLDER, 1_700_000_060_000),
    "phone lock: held by chore-issue496-phone-queue (pid 1234) for 1m0s",
  );
});

Deno.test("formatStatus: progress appends project, d/t and ETA", () => {
  assertEquals(
    formatStatus(HOLDER, 1_700_000_060_000, { project: "phone", done: 3, total: 21 }),
    "phone lock: held by chore-issue496-phone-queue (pid 1234) for 1m0s: phone, 3/21 specs, ~6 min left",
  );
  // no ETA before the first spec finishes or at completion
  assertEquals(
    formatStatus(HOLDER, 1_700_000_060_000, { project: "hybrid", done: 0, total: 18 }),
    "phone lock: held by chore-issue496-phone-queue (pid 1234) for 1m0s: hybrid, 0/18 specs",
  );
});

Deno.test("etaMinutes: rate-scaled remaining time, blank before first spec or at completion", () => {
  assertEquals(etaMinutes(120_000, 4, 10), 3); // 2 min elapsed / 4 done × 6 left
  assertEquals(etaMinutes(120_000, 0, 10), null);
  assertEquals(etaMinutes(120_000, 10, 10), null);
  assertEquals(etaMinutes(30_000, 1, 2), 1); // rounds up to at least 1 min
});

Deno.test("isPidAlive: own pid is alive, impossible pid is not", () => {
  assertEquals(isPidAlive(process.pid), true);
  assertEquals(isPidAlive(999_999_999), false);
});

Deno.test("waitLine: position + holder, free case", () => {
  assertEquals(
    waitLine(HOLDER, 1_700_000_150_000, { position: 3 }),
    "queued for the phone: position 3, holder chore-issue496-phone-queue",
  );
  assertEquals(
    waitLine(null, 1_700_000_150_000, { position: 2 }),
    "queued for the phone: position 2, phone lock free",
  );
});

Deno.test("waitLine: holder progress with project, d/t and ETA", () => {
  assertEquals(
    waitLine(HOLDER, 1_700_000_120_000, {
      position: 2,
      progress: { project: "hybrid", done: 14, total: 21 },
    }),
    "queued for the phone: position 2, holder chore-issue496-phone-queue (hybrid, 14/21 specs, ~1 min left)",
  );
  // ETA blank before the first spec finishes
  assertEquals(
    waitLine(HOLDER, 1_700_000_120_000, {
      position: 2,
      progress: { project: "phone", done: 0, total: 21 },
    }),
    "queued for the phone: position 2, holder chore-issue496-phone-queue (phone, 0/21 specs)",
  );
});

Deno.test("formatQueue: numbered lines with waiting since, empty for no queue", () => {
  assertEquals(
    formatQueue([{ worktree: "chore-issue508-phone-queue-eta", waitingSince: 1_700_000_000_000 }]),
    "queued:\n1. chore-issue508-phone-queue-eta since 2023-11-14T22:13:20.000Z",
  );
  assertEquals(
    formatQueue([
      { worktree: "wt-a", waitingSince: 1_700_000_000_000 },
      { worktree: "wt-b", waitingSince: 1_700_000_060_000 },
    ]),
    "queued:\n1. wt-a since 2023-11-14T22:13:20.000Z\n2. wt-b since 2023-11-14T22:14:20.000Z",
  );
  assertEquals(formatQueue([]), "");
});

Deno.test("findLockAncestor: direct parent holds the lock", () => {
  const proc = fakeProc({ 100: 50, 50: 1 }, { 50: [LOCK, "/dev/null"] });
  assertEquals(findLockAncestor(LOCK, 100, proc), 50);
});

Deno.test("findLockAncestor: grandparent holds the lock", () => {
  const proc = fakeProc({ 100: 50, 50: 10, 10: 1 }, { 10: [LOCK] });
  assertEquals(findLockAncestor(LOCK, 100, proc), 10);
});

Deno.test("findLockAncestor: an unrelated holder is not an ancestor", () => {
  const proc = fakeProc({ 100: 50, 50: 1 }, { 999: [LOCK] });
  assertEquals(findLockAncestor(LOCK, 100, proc), null);
});

Deno.test("findLockAncestor: unreadable /proc falls back to a normal acquire", () => {
  const proc = fakeProc({}, {});
  assertEquals(findLockAncestor(LOCK, 100, proc), null);
});

Deno.test("acquirePhoneLock: GEODE_PHONE_LOCK_HELD=1 skips acquiring", async () => {
  Deno.env.set("GEODE_PHONE_LOCK_HELD", "1");
  try {
    const lock = await acquirePhoneLock();
    await lock.release(); // no-op: the ancestor owns the real flock
  } finally {
    Deno.env.delete("GEODE_PHONE_LOCK_HELD");
  }
});
