import {
  ACTIVITY_CAP,
  ActivityEntry,
  ActivityFilter,
  ActivityInput,
  ActivityRecorder,
  applyActivityFilter,
  buildRows,
  parseActivity,
  recordActivity,
  resolveDeviceLabel,
  serializeActivity,
} from "../../../plugin/sync/activity-log.ts";
import { assertEquals } from "@std/assert";

// #431: the sync activity log is an obsidian-free pure module: per-file
// latest-activity collapse, save-count aggregation, never-collapsed kinds,
// day buckets, All/Conflicts/Errors filters, file-name search, relative vs
// absolute time. No I/O: `now` is injected, persistence is `serialize`/`parse`.

// Local-noon reference so bucket and clock-time assertions are timezone-stable.
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const AT = (d: Date): number => d.getTime();
const atMinutesAgo = (min: number): number => NOW - min * 60_000;

const DEVICE = "Laptop";
const MY_DEVICE = "dev-laptop";
const OTHER = "dev-phone";

function ctx(overrides: Partial<{ deviceName: string; myDeviceId: string; now: number }> = {}) {
  return {
    deviceName: overrides.deviceName ?? DEVICE,
    myDeviceId: overrides.myDeviceId ?? MY_DEVICE,
    now: overrides.now ?? NOW,
  };
}

function recordInto(
  entries: Map<string, ActivityEntry>,
  inputs: ActivityInput[],
  overrides: Partial<{ deviceName: string; myDeviceId: string }> = {},
): void {
  for (const input of inputs) recordActivity(entries, input, ctx(overrides));
}

function recorder(): { log: ActivityRecorder; writes: string[] } {
  const writes: string[] = [];
  const log = new ActivityRecorder({
    now: () => NOW,
    deviceName: () => DEVICE,
    myDeviceId: () => MY_DEVICE,
    persist: (json) => writes.push(json),
  });
  return { log, writes };
}

const rows = (
  entries: Map<string, ActivityEntry>,
  overrides: Partial<{ filter: ActivityFilter; query: string; now: number }> = {},
) =>
  buildRows(entries.values(), {
    filter: overrides.filter ?? "all",
    query: overrides.query ?? "",
    now: overrides.now ?? NOW,
  });

Deno.test("record uploads of one file collapse to one row with a save count", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "Notes/a.md", kind: "upload" },
    { path: "Notes/a.md", kind: "upload" },
    { path: "Notes/a.md", kind: "upload" },
  ]);
  assertEquals(entries.size, 1);
  const e = entries.get("Notes/a.md")!;
  assertEquals(e.kind, "upload");
  assertEquals(e.saves, 3);
  assertEquals(e.at, NOW); // latest event wins
});

Deno.test("interleaved A,B,A,B saves keep one row per file with per-file save counts", () => {
  const entries = new Map<string, ActivityEntry>();
  const seq = [0, 1, 0, 1, 0];
  let t = NOW - 60_000;
  for (const idx of seq) {
    t += 10_000;
    recordActivity(
      entries,
      { path: idx === 0 ? "a.md" : "b.md", kind: "upload" },
      { ...ctx(), now: t },
    );
  }
  assertEquals(entries.get("a.md")!.saves, 3);
  assertEquals(entries.get("b.md")!.saves, 2);
});

Deno.test("a delete between saves of the same file breaks the save run", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "upload" },
    { path: "a.md", kind: "upload" },
    { path: "a.md", kind: "delete", deviceId: null },
    { path: "a.md", kind: "upload" },
  ]);
  const e = entries.get("a.md")!;
  assertEquals(e.kind, "upload");
  assertEquals(e.saves, 1);
});

Deno.test("deletes, conflicts and errors are never collapsed into a save row", () => {
  for (
    const [input, kind] of [
      [{ path: "x.md", kind: "upload" }, "upload"],
      [{ path: "x.md", kind: "delete", deviceId: OTHER }, "delete"],
      [{ path: "y.md", kind: "upload" }, "upload"],
      [{ path: "y.md", kind: "conflict", deviceId: OTHER }, "conflict"],
      [{ path: "z.md", kind: "upload" }, "upload"],
      [{ path: "z.md", kind: "error", cause: "offline" }, "error"],
    ] as Array<[ActivityInput, ActivityEntry["kind"]]>
  ) {
    const entries = new Map<string, ActivityEntry>();
    recordInto(entries, [input]);
    assertEquals(entries.get(input.path)!.kind, kind);
  }
});

Deno.test("a delete overridden by a remote edit reads as restored, never as a plain download", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "delete", deviceId: null },
    { path: "a.md", kind: "download", deviceId: OTHER },
    { path: "a.md", kind: "restored", deviceId: OTHER },
  ]);
  const row = rows(entries).flatMap((g) => g.rows).find((r) => r.name === "a.md")!;
  assertEquals(row.entry.kind, "restored");
  assertEquals(row.detail, "Restored after your delete · Another device");
  assertEquals(row.absolute, true);
  assertEquals(parseActivity(serializeActivity(entries.values()))?.[0].kind, "restored");
});

Deno.test("device labels: own events use the device name, remote events a neutral label", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "upload" },
    { path: "b.md", kind: "download", deviceId: OTHER },
    { path: "c.md", kind: "delete", deviceId: null },
  ]);
  assertEquals(entries.get("a.md")!.deviceLabel, "Laptop");
  assertEquals(entries.get("b.md")!.deviceLabel, "Another device");
  assertEquals(entries.get("c.md")!.deviceLabel, "Laptop");
});

Deno.test("an empty device name falls back to a neutral own label", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "upload" },
    { path: "b.md", kind: "download", deviceId: OTHER },
    { path: "c.md", kind: "merge", deviceId: OTHER },
  ], { deviceName: "" });
  assertEquals(entries.get("a.md")!.deviceLabel, "This device");
  assertEquals(entries.get("b.md")!.deviceLabel, "Another device");
  assertEquals(entries.get("c.md")!.deviceLabel, "This device & Another device");
});

Deno.test("an event from the current device resolves to its own name", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [{ path: "b.md", kind: "download", deviceId: MY_DEVICE }]);
  assertEquals(entries.get("b.md")!.deviceLabel, "Laptop");
});

Deno.test("merges and conflicts list both this device and the remote", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "m.md", kind: "merge", deviceId: OTHER },
    { path: "c.md", kind: "conflict", deviceId: OTHER },
  ]);
  assertEquals(entries.get("m.md")!.deviceLabel, "Laptop & Another device");
  assertEquals(entries.get("c.md")!.deviceLabel, "Laptop & Another device");
});

Deno.test("a later download of the same path does not clobber a conflict entry", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "c.md", kind: "conflict", deviceId: OTHER }, ctx());
  recordActivity(entries, { path: "c.md", kind: "download", deviceId: OTHER }, ctx());
  const e = entries.get("c.md")!;
  assertEquals(e.kind, "conflict");
  assertEquals(e.deviceId, OTHER);
});

Deno.test("a later restore of the same path does not clobber a conflict entry", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "c.md", kind: "conflict", deviceId: OTHER }, ctx());
  recordActivity(entries, { path: "c.md", kind: "restored", deviceId: OTHER }, ctx());
  const e = entries.get("c.md")!;
  assertEquals(e.kind, "conflict", "the unresolved conflict stays resolvable");
  assertEquals(e.deviceId, OTHER, "its remote side is still known");
});

Deno.test("resolved rows keep the kept-side label and show an absolute clock time", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(
    entries,
    { path: "c.md", kind: "resolved", label: "kept Phone's version" },
    { ...ctx(), now: AT(new Date(2026, 9, 14, 13, 8, 0)) },
  );
  const e = entries.get("c.md")!;
  assertEquals(e.deviceId, null);
  assertEquals(e.deviceLabel, "kept Phone's version");
  const [group] = rows(entries);
  const row = group.rows[0];
  assertEquals(row.detail, "Resolved · kept Phone's version");
  assertEquals(row.icon, "git-merge");
  assertEquals(row.absolute, true);
  assertEquals(row.time, "13:08");
});

Deno.test("error rows carry the cause instead of a device", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [{ path: "e.md", kind: "error", cause: "Couldn't reach sync.example.org" }]);
  const e = entries.get("e.md")!;
  assertEquals(e.cause, "Couldn't reach sync.example.org");
  const [group] = rows(entries);
  const row = group.rows[0];
  assertEquals(row.detail, "Error · Couldn't reach sync.example.org");
  assertEquals(row.absolute, true);
});

Deno.test("day buckets: today, yesterday, earlier, and the midnight boundary", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "today.md", kind: "upload" }, { ...ctx(), now: NOW - 60_000 });
  recordActivity(entries, { path: "yesterday.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 25 * 3_600_000,
  });
  recordActivity(entries, { path: "earlier.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 3 * 86_400_000,
  });
  const groups = rows(entries);
  assertEquals(groups.map((g) => g.label), ["Today", "Yesterday", "Earlier"]);

  // Midnight boundary: 00:00 today is "today", 23:59 yesterday is "yesterday".
  const atMidnight = AT(new Date(2026, 9, 14, 0, 0, 0));
  const beforeMidnight = atMidnight - 60_000;
  assertEquals(
    buildRows(entries.values(), { filter: "all", query: "", now: atMidnight }).length,
    3,
  );
  const early = new Map<string, ActivityEntry>();
  recordActivity(early, { path: "edge.md", kind: "upload" }, { ...ctx(), now: atMidnight });
  recordActivity(early, { path: "edge2.md", kind: "upload" }, { ...ctx(), now: beforeMidnight });
  const g = buildRows(early.values(), { filter: "all", query: "", now: atMidnight });
  assertEquals(g.map((x) => x.label), ["Today", "Yesterday"]);
});

Deno.test("relative time for ordinary rows, absolute clock for delete/conflict/error", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "just.md", kind: "upload" }, { ...ctx(), now: NOW });
  recordActivity(entries, { path: "min.md", kind: "upload" }, { ...ctx(), now: NOW - 3 * 60_000 });
  recordActivity(entries, { path: "hour.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 5 * 3_600_000,
  });
  recordActivity(entries, { path: "del.md", kind: "delete", deviceId: OTHER }, {
    ...ctx(),
    now: atMinutesAgo(120),
  });
  recordActivity(
    entries,
    { path: "cf.md", kind: "conflict", deviceId: OTHER },
    { ...ctx(), now: AT(new Date(2026, 9, 14, 13, 8, 0)) },
  );
  const byPath = new Map(rows(entries).flatMap((g) => g.rows).map((r) => [r.name, r]));
  assertEquals(byPath.get("just.md")!.time, "just now");
  assertEquals(byPath.get("min.md")!.time, "3 min ago");
  assertEquals(byPath.get("hour.md")!.time, "5 h ago");
  assertEquals(byPath.get("del.md")!.time, "10:00");
  assertEquals(byPath.get("del.md")!.absolute, true);
  assertEquals(byPath.get("cf.md")!.time, "13:08");
  assertEquals(byPath.get("cf.md")!.absolute, true);
});

Deno.test("yesterday rows show yesterday, earlier rows show days ago", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "y.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 30 * 3_600_000,
  });
  recordActivity(entries, { path: "e.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 2 * 86_400_000,
  });
  const byPath = new Map(rows(entries).flatMap((g) => g.rows).map((r) => [r.name, r]));
  assertEquals(byPath.get("y.md")!.time, "yesterday");
  assertEquals(byPath.get("e.md")!.time, "2 days ago");
});

Deno.test("save count appears only when a file was saved more than once", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "once.md", kind: "upload" },
    { path: "many.md", kind: "upload" },
    { path: "many.md", kind: "upload" },
    { path: "many.md", kind: "upload" },
  ]);
  const byPath = new Map(rows(entries).flatMap((g) => g.rows).map((r) => [r.name, r]));
  assertEquals(byPath.get("once.md")!.detail, "Uploaded · Laptop");
  assertEquals(byPath.get("many.md")!.detail, "Uploaded · Laptop · 3 saves");
});

Deno.test("filters: All shows everything, Conflicts/Errors only their kinds, deletes under All only", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "u.md", kind: "upload" },
    { path: "d.md", kind: "delete", deviceId: OTHER },
    { path: "c.md", kind: "conflict", deviceId: OTHER },
    { path: "e.md", kind: "error", cause: "offline" },
  ]);
  assertEquals(rows(entries, { filter: "all" }).flatMap((g) => g.rows).map((r) => r.name).sort(), [
    "c.md",
    "d.md",
    "e.md",
    "u.md",
  ]);
  assertEquals(rows(entries, { filter: "conflict" }).flatMap((g) => g.rows).map((r) => r.name), [
    "c.md",
  ]);
  assertEquals(rows(entries, { filter: "error" }).flatMap((g) => g.rows).map((r) => r.name), [
    "e.md",
  ]);
  const filtered = applyActivityFilter(entries.values(), "conflict");
  assertEquals(filtered.map((e) => e.path), ["c.md"]);
});

Deno.test("search filters by file name, case-insensitive; unmatched query yields no groups", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "Notes/Meeting notes.md", kind: "upload" },
    { path: "Daily/2026-10-14.md", kind: "download", deviceId: OTHER },
  ]);
  assertEquals(rows(entries, { query: "meeting" }).flatMap((g) => g.rows).map((r) => r.name), [
    "Meeting notes.md",
  ]);
  assertEquals(rows(entries, { query: "NOTES" }).flatMap((g) => g.rows).map((r) => r.name), [
    "Meeting notes.md",
  ]);
  assertEquals(rows(entries, { query: "zzz" }).length, 0);
});

Deno.test("rows are most recent first within a bucket", () => {
  const entries = new Map<string, ActivityEntry>();
  recordActivity(entries, { path: "old.md", kind: "upload" }, {
    ...ctx(),
    now: NOW - 2 * 3_600_000,
  });
  recordActivity(entries, { path: "new.md", kind: "upload" }, { ...ctx(), now: NOW - 60_000 });
  const today = rows(entries).find((g) => g.label === "Today")!;
  assertEquals(today.rows.map((r) => r.name), ["new.md", "old.md"]);
});

Deno.test("the log is capped, evicting the oldest entry", () => {
  const entries = new Map<string, ActivityEntry>();
  let t = NOW - (ACTIVITY_CAP + 50) * 60_000;
  for (let i = 0; i < ACTIVITY_CAP + 50; i++) {
    t += 60_000;
    recordActivity(entries, { path: `f${i}.md`, kind: "upload" }, { ...ctx(), now: t });
  }
  assertEquals(entries.size, ACTIVITY_CAP);
  assertEquals(entries.has("f0.md"), false);
  assertEquals(entries.has(`f${ACTIVITY_CAP + 49}.md`), true);
});

Deno.test("serialize/parse round-trips entries and ordering", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "upload" },
    { path: "b.md", kind: "conflict", deviceId: OTHER },
  ]);
  const parsed = parseActivity(serializeActivity(entries.values()))!;
  assertEquals(parsed.length, 2);
  assertEquals(parsed.find((e) => e.path === "a.md")!.saves, 1);
  assertEquals(parsed.find((e) => e.path === "b.md")!.deviceLabel, "Laptop & Another device");
});

Deno.test("parseActivity tolerates torn or missing files, returning null", () => {
  assertEquals(parseActivity(null), null);
  assertEquals(parseActivity("{ not json"), null);
  assertEquals(parseActivity('{"entries": "nope"}'), null);
  assertEquals(parseActivity('{"entries": [{"path": 5}]}'), null);
  assertEquals(parseActivity('{"version":1,"entries":[]}'), []);
});

Deno.test("parseActivity rejects entries with an unknown kind", () => {
  assertEquals(parseActivity('{"entries": [{"path": "a.md", "kind": "bogus", "at": 1}]}'), null);
});

Deno.test("resolveDeviceLabel maps remote ids to names, keeps unknown ids neutral", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [
    { path: "a.md", kind: "download", deviceId: OTHER },
    { path: "b.md", kind: "download", deviceId: "dev-gone" },
    { path: "c.md", kind: "merge", deviceId: OTHER },
    { path: "d.md", kind: "upload" },
  ]);
  const names = new Map([
    [OTHER, "Phone"],
    [MY_DEVICE, "Laptop"],
  ]);
  const label = (path: string) => resolveDeviceLabel(entries.get(path)!, names);
  assertEquals(label("a.md"), "Phone");
  assertEquals(label("b.md"), "Another device");
  assertEquals(label("c.md"), "Laptop & Phone");
  assertEquals(label("d.md"), "Laptop");
});

Deno.test("buildRows resolves remote device names when a name map is passed", () => {
  const entries = new Map<string, ActivityEntry>();
  recordInto(entries, [{ path: "a.md", kind: "download", deviceId: OTHER }]);
  const groups = buildRows(entries.values(), {
    filter: "all",
    query: "",
    now: NOW,
    deviceNames: new Map([
      [OTHER, "Phone"],
    ]),
  });
  assertEquals(groups[0].rows[0].detail, "Downloaded · Phone");
});

Deno.test("the recorder persists throttled and flushes on demand", () => {
  const { log, writes } = recorder();
  log.record({ path: "a.md", kind: "upload" });
  log.record({ path: "b.md", kind: "upload" });
  assertEquals(writes.length, 0); // throttled: nothing written synchronously
  log.flush();
  assertEquals(writes.length, 1);
  const parsed = parseActivity(writes[0])!;
  assertEquals(parsed.length, 2);
});

Deno.test("the recorder loads a persisted log and survives a torn load as empty", () => {
  const { log, writes } = recorder();
  log.record({ path: "a.md", kind: "upload" });
  log.flush();
  const fresh = recorder().log;
  fresh.load(writes[0]);
  assertEquals(fresh.entries.get("a.md")!.saves, 1);
  const torn = recorder().log;
  torn.load("{ garbage");
  assertEquals(torn.entries.size, 0);
});

Deno.test("clear empties the log and cancels pending writes", () => {
  const { log, writes } = recorder();
  log.record({ path: "a.md", kind: "upload" });
  log.clear();
  assertEquals(log.entries.size, 0);
  assertEquals(writes.length, 0);
});
