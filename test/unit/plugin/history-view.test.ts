import { assertEquals } from "@std/assert";
import type { HistoryItem, HistoryPeriod } from "../../../plugin/ui/history-periods.ts";
import {
  backToList,
  changeLines,
  EMPTY_DESC,
  EMPTY_TITLE,
  HISTORY_ENTRY_TITLE,
  historySubtitle,
  historyTitle,
  type HistoryView,
  initialView,
  newestLive,
  OLDER_ERROR_TEXT,
  PERIODS_PER_PAGE,
  previewCaption,
  previewState,
  RETRY_BUTTON,
  selectedRow,
  selectSave,
  showOlder,
  toggleDiff,
  toggleExpanded,
  visibleRows,
} from "../../../plugin/ui/history-view.ts";

// #464: the history modal's view model: paging over the period list, selection,
// what the right pane offers, and the line diff against the current version.

const DAY = 86_400_000;
const now = new Date(2026, 4, 12, 14, 20, 0).getTime();

/** A save's identity in the window: versions repeat from name to name (#583). */
const key = (version: number) => `hash-a:${version}`;

/** One period per day, oldest last: the shape buildHistory returns. */
function period(version: number, device = "This laptop", at = now): HistoryPeriod {
  return {
    kind: "period",
    deviceId: `id-${device}`,
    device,
    saves: [{ key: key(version), version, at }],
  };
}

const view = (over: Partial<HistoryView> = {}): HistoryView => ({
  expanded: new Set<string>(),
  selected: key(1),
  showDiff: false,
  shown: PERIODS_PER_PAGE,
  pane: "list",
  ...over,
});

Deno.test("history-view - historyTitle names the file without dashes", () => {
  assertEquals(historyTitle("Notes/Meeting notes.md"), "History · Meeting notes.md");
  assertEquals(historyTitle("Meeting notes.md"), "History · Meeting notes.md");
  assertEquals(HISTORY_ENTRY_TITLE, "Geode: Show file history");
});

Deno.test("history-view - historySubtitle shows the folder then the head's device", () => {
  assertEquals(historySubtitle("Notes/Meeting notes.md", "This laptop"), "Notes/ · This laptop");
  assertEquals(historySubtitle("Meeting notes.md", "This laptop"), "This laptop");
  assertEquals(EMPTY_TITLE, "No earlier versions yet.");
  assertEquals(EMPTY_DESC, "Saved versions appear here as you edit.");
});

Deno.test("history-view - previewCaption is a save's clock time and its device", () => {
  const save = { at: now, device: "Phone", event: null };
  assertEquals(previewCaption(save), "14:20 · Phone");
  // A save whose device the vault never saw names no device (#687).
  assertEquals(previewCaption({ ...save, device: null }), "14:20");
});

// #691: the phone shows a restore in a full screen preview, so its caption carries the
// row's words: a clock time alone would not say what the version is.
Deno.test("history-view - previewCaption names a restore's own words", () => {
  const restored = { at: now, device: "Phone", event: "restored" as const };
  assertEquals(previewCaption(restored), "Restored from trash on Phone · 14:20");
  assertEquals(previewCaption({ ...restored, device: null }), "Restored from trash · 14:20");
});

Deno.test("history-view - newestLive skips deletion tombstones", () => {
  const chain = [
    { version: 5, deleted: 1 },
    { version: 4, deleted: 0 },
    { version: 3, deleted: 0 },
  ];
  assertEquals(newestLive(chain), { version: 4, deleted: 0 });
  assertEquals(newestLive([{ version: 2, deleted: 1 }]), null);
  assertEquals(newestLive([]), null);
});

Deno.test("history-view - initialView selects the newest live version", () => {
  const multiSave: HistoryPeriod = {
    kind: "period",
    deviceId: "id-This laptop",
    device: "This laptop",
    saves: [
      { key: key(3), version: 3, at: now - 60_000 },
      { key: key(4), version: 4, at: now },
    ],
  };
  const older = period(2, "Phone", now - 3 * DAY);
  assertEquals(initialView([multiSave, older], key(3)), {
    expanded: new Set<string>(),
    selected: key(3),
    showDiff: false,
    shown: PERIODS_PER_PAGE,
    pane: "list",
  });
});

Deno.test("history-view - initialView of an empty chain is null", () => {
  assertEquals(initialView([], key(1)), null);
  assertEquals(initialView([{ kind: "gap" }], key(1)), null);
});

Deno.test("history-view - visibleRows pages the periods, newest first", () => {
  const items: HistoryItem[] = [period(9), period(8, "Phone"), period(7), period(6), period(5)];
  const first = visibleRows(items, PERIODS_PER_PAGE);
  assertEquals(first.rows, items.slice(0, PERIODS_PER_PAGE));
  assertEquals(first.morePeriods, true);
});

Deno.test("history-view - visibleRows shows every period and the gap when all are revealed", () => {
  const items: HistoryItem[] = [period(9), period(5, "Phone"), { kind: "gap" }];
  const all = visibleRows(items, 2);
  assertEquals(all.rows, items);
  assertEquals(all.morePeriods, false);
});

Deno.test("history-view - visibleRows without a compacted range has no gap", () => {
  const all = visibleRows([period(2), period(1)], 2);
  assertEquals(all.rows, [period(2), period(1)]);
  assertEquals(all.morePeriods, false);
});

Deno.test("history-view - a marker row waits until the periods above it are in", () => {
  const items: HistoryItem[] = [
    period(5),
    period(4),
    { kind: "marker", from: "Notes/Old name.md" },
    period(3),
    period(2),
    period(1),
  ];
  assertEquals(visibleRows(items, 2).rows, [period(5), period(4)], "marker not yet");
  assertEquals(visibleRows(items, 3).rows, items.slice(0, 4));
  assertEquals(visibleRows(items, 6).rows, items);
});

Deno.test("history-view - selectSave moves the selection, drops the diff, opens the phone preview", () => {
  const next = selectSave(view({ showDiff: true }), key(7));
  assertEquals(next.selected, key(7));
  assertEquals(next.showDiff, false);
  assertEquals(next.pane, "preview");
  assertEquals(backToList(next).pane, "list");
});

Deno.test("history-view - visibleRows keeps an event row behind its periods", () => {
  const items: HistoryItem[] = [
    period(6),
    { kind: "event", event: "restored", device: "Phone", at: now, key: key(5), version: 5 },
    period(4),
    period(3),
  ];
  assertEquals(visibleRows(items, 1).rows, [period(6)]);
  assertEquals(visibleRows(items, 2).rows, items.slice(0, 3));
});

Deno.test("history-view - selectedRow names the row's time and device", () => {
  const periodTwo: HistoryPeriod = {
    kind: "period",
    deviceId: "id-Phone",
    device: "Phone",
    saves: [
      { key: key(7), version: 7, at: now - DAY },
      { key: key(8), version: 8, at: now },
    ],
  };
  const items: HistoryItem[] = [
    { kind: "event", event: "restored", device: "Phone", at: now, key: key(10), version: 10 },
    period(9),
    periodTwo,
  ];
  assertEquals(selectedRow(items, key(7)), { at: now - DAY, device: "Phone", event: null });
  assertEquals(selectedRow(items, key(10)), { at: now, device: "Phone", event: "restored" });
  assertEquals(selectedRow(items, key(99)), null);
});

Deno.test("history-view - toggleDiff flips the pane between version and changes", () => {
  assertEquals(toggleDiff(view()).showDiff, true);
  assertEquals(toggleDiff(view({ showDiff: true })).showDiff, false);
});

Deno.test("history-view - toggleExpanded opens and closes one period at a time", () => {
  const open = toggleExpanded(toggleExpanded(view(), 9), 5);
  assertEquals([...open.expanded], [9, 5]);
  assertEquals([...toggleExpanded(open, 9).expanded], [5]);
});

Deno.test("history-view - showOlder reveals another page", () => {
  assertEquals(showOlder(view()).shown, PERIODS_PER_PAGE * 2);
});

Deno.test("history-view - previewState offers Changes for live markdown only", () => {
  assertEquals(previewState(view(), "text"), { mode: "version", toggle: "Changes" });
  assertEquals(previewState(view({ showDiff: true }), "text"), {
    mode: "diff",
    toggle: "Show version",
  });
  assertEquals(previewState(view({ showDiff: true }), "image"), { mode: "version", toggle: null });
  assertEquals(previewState(view({ showDiff: true }), "binary"), { mode: "version", toggle: null });
});

Deno.test("history-view - older-page copy", () => {
  assertEquals(OLDER_ERROR_TEXT, "Couldn't load older versions.");
  assertEquals(RETRY_BUTTON, "Retry");
});

Deno.test("history-view - changeLines marks the version's own lines as removed", () => {
  const version = "# Meeting notes\n\nStarted from a phone draft on the train.";
  const current = "# Meeting notes\n\n## Agenda\n- Sync status";
  assertEquals(changeLines(version, current), [
    { kind: "same", text: "# Meeting notes" },
    { kind: "same", text: "" },
    { kind: "remove", text: "− Started from a phone draft on the train." },
    { kind: "add", text: "+ ## Agenda" },
    { kind: "add", text: "+ - Sync status" },
  ]);
});

Deno.test("history-view - changeLines of the current version is all unchanged", () => {
  assertEquals(changeLines("# A\nbody", "# A\nbody"), [
    { kind: "same", text: "# A" },
    { kind: "same", text: "body" },
  ]);
  assertEquals(changeLines("", ""), [{ kind: "same", text: "" }]);
});

Deno.test("history-view - changeLines of an empty version replaces the empty line", () => {
  assertEquals(changeLines("", "# A"), [
    { kind: "remove", text: "− " },
    { kind: "add", text: "+ # A" },
  ]);
});
