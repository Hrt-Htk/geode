import { assertEquals } from "@std/assert";
import {
  buildHistory,
  eventLabel,
  eventText,
  gapLabel,
  type HistoryEvent,
  type HistoryItem,
  periodLabel,
  savesLabel,
  timeLabel,
} from "../../../plugin/ui/history-periods.ts";
import type { HistorySegment } from "../../../plugin/sync/history-fetch.ts";

// #462: a file's version chain → editing periods and the retention gap.
const LAPTOP = "device-laptop";
const PHONE = "device-phone";
const TABLET = "device-tablet";
const NAMES = new Map([[LAPTOP, "This laptop"], [PHONE, "Phone"]]);

const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 4, day, hour, minute, 0).getTime();
const NOW = at(12, 18, 0);

type RowOpts = { compacted?: string | null; restored?: boolean; deleted?: number };

function row(version: number, created: number, deviceId: string, opts: RowOpts = {}) {
  return {
    version,
    created_at: created,
    device_id: deviceId,
    compacted_range: opts.compacted ?? null,
    restored: opts.restored,
    deleted: opts.deleted ?? 0,
  };
}

const summary = (items: HistoryItem[]) =>
  items.map((i) => {
    if (i.kind === "marker") return `marker:${i.from}`;
    if (i.kind === "gap") return "gap";
    if (i.kind === "event") return `event:${i.event}:${i.version}`;
    return `period:${i.device}:${i.saves.map((s) => s.version).join(",")}`;
  });

/** One name's rows, the shape a single-generation window always produces. */
const name = (
  versions: ReturnType<typeof row>[],
  from: string | null = null,
  pathHash = "hash-a",
): HistorySegment => ({ pathHash, from, versions: versions as HistorySegment["versions"] });
const oneName = (versions: ReturnType<typeof row>[]) => [name(versions)];

Deno.test("buildHistory - empty chain has no history", () => {
  assertEquals(buildHistory([], NAMES), []);
});

Deno.test("buildHistory - one version is one single-save period", () => {
  const items = buildHistory(oneName([row(1, at(12, 14, 2), LAPTOP)]), NAMES);
  assertEquals(items, [{
    kind: "period",
    deviceId: LAPTOP,
    device: "This laptop",
    saves: [{ key: "hash-a:1", version: 1, at: at(12, 14, 2) }],
  }]);
  assertEquals(periodLabel(items[0] as never, NOW), "Today 14:02 · This laptop");
});

Deno.test("buildHistory - a burst of saves collapses into one period", () => {
  const chain = [
    row(3, at(12, 14, 20), LAPTOP),
    row(2, at(12, 14, 11), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  const items = buildHistory(oneName(chain), NAMES);
  assertEquals(summary(items), ["period:This laptop:1,2,3"]);
  assertEquals(periodLabel(items[0] as never, NOW), "Today 14:02 to 14:20 · This laptop");
});

Deno.test("buildHistory - saves inside one minute show a single time", () => {
  const chain = [
    row(2, at(12, 14, 2) + 30_000, LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  const items = buildHistory(oneName(chain), NAMES);
  assertEquals(summary(items), ["period:This laptop:1,2"]);
  assertEquals(periodLabel(items[0] as never, NOW), "Today 14:02 · This laptop");
});

Deno.test("buildHistory - an idle gap over the threshold starts a new period", () => {
  const chain = [
    row(2, at(12, 14, 20), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), [
    "period:This laptop:2",
    "period:This laptop:1",
  ]);
});

Deno.test("buildHistory - a save inside the threshold stays in the period", () => {
  const chain = [
    row(2, at(12, 14, 16), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), ["period:This laptop:1,2"]);
});

Deno.test("buildHistory - a calendar-day boundary splits the period", () => {
  const chain = [
    row(2, at(12, 0, 2), LAPTOP),
    row(1, at(11, 23, 58), LAPTOP),
  ];
  const items = buildHistory(oneName(chain), NAMES);
  assertEquals(summary(items), ["period:This laptop:2", "period:This laptop:1"]);
  assertEquals(periodLabel(items[1] as never, NOW), "Yesterday 23:58 · This laptop");
});

Deno.test("buildHistory - interleaved devices get one period each", () => {
  const chain = [
    row(3, at(12, 14, 20), LAPTOP),
    row(2, at(12, 14, 10), PHONE),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), [
    "period:This laptop:3",
    "period:Phone:2",
    "period:This laptop:1",
  ]);
});

Deno.test("buildHistory - a compacted chain ends in the retention gap", () => {
  // v12 folds 8-12 and v7 folds 2-7: compaction dropped the rows between them.
  const chain = [
    row(12, at(12, 14, 20), LAPTOP, { compacted: "8-12" }),
    row(7, at(12, 11, 0), LAPTOP, { compacted: "2-7" }),
    row(1, at(12, 9, 0), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), [
    "period:This laptop:12",
    "period:This laptop:7",
    "period:This laptop:1",
    "gap",
  ]);
  assertEquals(gapLabel(), "Older versions were merged after 30 days");
});

Deno.test("buildHistory - no gap entry without a compacted range", () => {
  const chain = [
    row(2, at(12, 14, 10), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), ["period:This laptop:1,2"]);
});

Deno.test("buildHistory - output is newest first whatever the input order", () => {
  const chain = [
    row(1, at(11, 9, 0), TABLET),
    row(3, at(12, 14, 20), LAPTOP),
    row(2, at(12, 13, 0), PHONE),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), [
    "period:This laptop:3",
    "period:Phone:2",
    "period:Another device:1",
  ]);
});

Deno.test("timeLabel - local 24-hour clock, zero padded", () => {
  assertEquals(timeLabel(at(12, 9, 5)), "09:05");
  assertEquals(timeLabel(at(12, 14, 20)), "14:20");
});

Deno.test("savesLabel - counts saves", () => {
  assertEquals(savesLabel(1), "1 save");
  assertEquals(savesLabel(9), "9 saves");
});

Deno.test("periodLabel - day buckets against now", () => {
  const day = (version: number, created: number) => ({
    kind: "period" as const,
    deviceId: LAPTOP,
    device: "This laptop",
    saves: [{ version, at: created }],
  });
  assertEquals(periodLabel(day(1, at(12, 14, 2)), NOW), "Today 14:02 · This laptop");
  assertEquals(periodLabel(day(1, at(9, 14, 2)), NOW), "3 days ago 14:02 · This laptop");
});

/* #583: a window spans several names: one segment per name, a marker row where
 * the walk crossed a rename, and a retention gap per name. */

Deno.test("buildHistory - a marker row sits between the generations", () => {
  const segments: HistorySegment[] = [
    name([row(4, at(12, 14, 20), LAPTOP), row(3, at(12, 14, 2), LAPTOP)], "Notes/Old name.md"),
    name([row(2, at(11, 9, 5), PHONE), row(1, at(11, 9, 0), PHONE)], null, "hash-b"),
  ];
  assertEquals(summary(buildHistory(segments, NAMES)), [
    "period:This laptop:4",
    "period:This laptop:3",
    "marker:Notes/Old name.md",
    "period:Phone:1,2",
  ]);
});

Deno.test("buildHistory - each name ends in its own retention gap", () => {
  const segments: HistorySegment[] = [
    name(
      [row(6, at(12, 14, 20), LAPTOP, { compacted: "3-6" }), row(3, at(12, 14, 2), LAPTOP)],
      "B.md",
    ),
    name(
      [row(2, at(11, 9, 5), PHONE, { compacted: "1-2" }), row(1, at(11, 9, 0), PHONE)],
      null,
      "hash-b",
    ),
  ];
  assertEquals(summary(buildHistory(segments, NAMES)), [
    "period:This laptop:6",
    "period:This laptop:3",
    "gap",
    "marker:B.md",
    "period:Phone:1,2",
    "gap",
  ]);
});

Deno.test("buildHistory - a walk that stopped at a marker adds no marker row", () => {
  const segments: HistorySegment[] = [
    name([row(2, at(12, 14, 20), LAPTOP), row(1, at(12, 14, 2), LAPTOP)], "B.md"),
  ];
  assertEquals(summary(buildHistory(segments, NAMES)), [
    "period:This laptop:2",
    "period:This laptop:1",
  ]);
});

Deno.test("buildHistory - periods never span a rename", () => {
  const at12 = at(12, 14, 2);
  const segments: HistorySegment[] = [
    name([row(2, at(12, 14, 10), LAPTOP)], "B.md"),
    name([row(1, at12, LAPTOP)], null, "hash-b"),
  ];
  assertEquals(summary(buildHistory(segments, NAMES)), [
    "period:This laptop:2",
    "marker:B.md",
    "period:This laptop:1",
  ]);
});

/* #691: a deletion and a restore from trash are their own one-line rows, like the
 * rename marker: they split editing periods and show without expanding. */

Deno.test("buildHistory - a deletion is its own row and splits the period", () => {
  // v4 and v3 are 12 min apart: inside the period gap, still split by the deletion.
  const chain = [
    row(4, at(12, 14, 20), LAPTOP),
    row(3, at(12, 14, 8), LAPTOP, { deleted: 1 }),
    row(2, at(12, 14, 6), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  const items = buildHistory(oneName(chain), NAMES);
  assertEquals(summary(items), [
    "period:This laptop:4",
    "event:deleted:3",
    "period:This laptop:1,2",
  ]);
  assertEquals(eventLabel(items[1] as HistoryEvent, NOW), "Today 14:08 · Deleted on This laptop");
});

Deno.test("buildHistory - a restore is its own row and keeps its own key", () => {
  const chain = [
    row(3, at(12, 14, 8), PHONE, { restored: true }),
    row(2, at(12, 14, 6), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  const items = buildHistory(oneName(chain), NAMES);
  assertEquals(summary(items), ["event:restored:3", "period:This laptop:1,2"]);
  const event = items[0] as HistoryEvent;
  // A restore row is a saved version with content, so it previews like a save.
  assertEquals(event.key, "hash-a:3");
  assertEquals(eventLabel(event, NOW), "Today 14:08 · Restored from trash on Phone");
});

Deno.test("buildHistory - repeated deletes and restores read in order", () => {
  const chain = [
    row(6, at(12, 14, 20), LAPTOP, { restored: true }),
    row(5, at(12, 14, 15), LAPTOP, { deleted: 1 }),
    row(4, at(12, 14, 10), LAPTOP, { restored: true }),
    row(3, at(12, 14, 8), LAPTOP, { deleted: 1 }),
    row(2, at(12, 14, 6), LAPTOP),
    row(1, at(12, 14, 2), LAPTOP),
  ];
  assertEquals(summary(buildHistory(oneName(chain), NAMES)), [
    "event:restored:6",
    "event:deleted:5",
    "event:restored:4",
    "event:deleted:3",
    "period:This laptop:1,2",
  ]);
});

Deno.test("eventLabel - a device the vault never saw is not named", () => {
  const items = buildHistory(
    oneName([
      row(3, at(12, 14, 8), "device-gone", { restored: true }),
      row(2, at(12, 14, 6), "device-gone", { deleted: 1 }),
    ]),
    NAMES,
  );
  assertEquals(eventLabel(items[0] as HistoryEvent, NOW), "Today 14:08 · Restored from trash");
  assertEquals(eventLabel(items[1] as HistoryEvent, NOW), "Today 14:06 · Deleted");
});

// #691: the words are the same on the row and in the preview caption, which reads them
// in the other order; one function builds them.
Deno.test("eventText - the event's words, with its device when the vault knows it", () => {
  assertEquals(eventText("restored", "Phone"), "Restored from trash on Phone");
  assertEquals(eventText("deleted", "Phone"), "Deleted on Phone");
  assertEquals(eventText("restored", null), "Restored from trash");
});
