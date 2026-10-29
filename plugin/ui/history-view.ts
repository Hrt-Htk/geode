// #464: the file history modal's view model: paging over the period list,
// selection, what the right pane offers, and the line diff against the current
// version. Obsidian-free, so history-modal.ts stays a thin shell.

import {
  eventText,
  type HistoryEvent,
  type HistoryItem,
  type HistoryPeriod,
  timeLabel,
} from "./history-periods.ts";
import type { VersionPreview } from "./history-preview.ts";
import { alignLines } from "./line-diff.ts";

/** Periods revealed before "Show older" also pages the chain (`nextUpTo`). */
export const PERIODS_PER_PAGE = 4;

export const HISTORY_ENTRY_TITLE = "Geode: Show file history";
export const OLDER_BUTTON = "Show older";
export const OLDER_ERROR_TEXT = "Couldn't load older versions.";
export const RETRY_BUTTON = "Retry";
export const BACK_BUTTON = "Back";
export const DONE_BUTTON = "Done";
export const LOADING_TEXT = "Loading…";
export const ERROR_TEXT = "Couldn't load this history.";
export const EMPTY_TITLE = "No earlier versions yet.";
export const EMPTY_DESC = "Saved versions appear here as you edit.";
export const NAME_CAPPED_TEXT = "History of this file, up to the deleted version.";
export const DIFF_CAPTION = "Changes vs the current version";
// #465: Restore this version: one confirm, then the old content is committed as a
// NEW head version (append only), so the content it replaces stays in history.
export const RESTORE_BUTTON = "Restore this version";
export const RESTORE_NOTICE = "Restored and saved as a new version";
export const RESTORE_UNCHANGED_NOTICE = "That version is already the current content.";
export const RESTORE_FAILED_NOTICE = "Couldn't restore this version.";
export const RESTORE_BUSY_NOTICE = "Still syncing this file. Try again in a moment.";
export const RESTORE_PAUSED_NOTICE = "Sync is paused. Resume sync to restore this version.";
export const RESTORE_UNSYNCED_NOTICE = "Restored on this device but it has not synced yet.";

export type HistoryView = {
  /** Expanded rows: see `periodKey`; a deletion row expands under its own key. */
  expanded: ReadonlySet<string>;
  /** The selected save: see `saveKey`. */
  selected: string;
  showDiff: boolean;
  /** Periods revealed so far. */
  shown: number;
  /** Phone only: the list, or one version with Back. */
  pane: "list" | "preview";
};

/** Newest version whose content still exists. A deletion is a tombstone with no
 * chunks, so it can be neither previewed nor diffed. */
export function newestLive<T extends { version: number; deleted: number }>(chain: T[]): T | null {
  return chain.find((row) => !row.deleted) ?? null;
}

/** #583: "Renamed from Notes/Old name.md": the row between two names. */
export function markerLabel(from: string): string {
  return `Renamed from ${from}`;
}

/** "History · Meeting notes.md": the modal's title. */
export function historyTitle(path: string): string {
  return `History · ${path.slice(path.lastIndexOf("/") + 1)}`;
}

/** "Notes/ · This laptop": the file's folder, then the head version's device. */
export function historySubtitle(path: string, device: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? device : `${path.slice(0, cut + 1)} · ${device}`;
}

/** A selected row: its time, its device, and the fact a restore records (#691). */
export type SelectedRow = {
  at: number;
  device: string | null;
  /** null for a save. A deletion has no content, so it is never selected. */
  event: HistoryEvent["event"] | null;
};

/** The preview's caption under the version: "14:20 · Phone" for a save. A restore
 * names its own words, since its clock time alone says nothing on a screen with one
 * version in it (#691). */
export function previewCaption(row: SelectedRow): string {
  const time = timeLabel(row.at);
  if (row.event !== null) return `${eventText(row.event, row.device)} · ${time}`;
  return row.device ? `${time} · ${row.device}` : time;
}

export function periodKey(period: HistoryPeriod): string {
  return period.saves[0].key;
}

/** The modal's opening state, with `selected` (the newest live version) picked. */
export function initialView(items: HistoryItem[], selected: string): HistoryView | null {
  if (!items.some((item) => item.kind === "period")) return null;
  return {
    expanded: new Set(),
    selected,
    showDiff: false,
    shown: PERIODS_PER_PAGE,
    pane: "list",
  };
}

/** The selected row's time, device and event kind: a save in its period, or a restore
 * row. */
export function selectedRow(items: HistoryItem[], key: string): SelectedRow | null {
  for (const item of items) {
    if (item.kind === "event" && item.key === key) {
      return { at: item.at, device: item.device, event: item.event };
    }
    if (item.kind !== "period") continue;
    const save = item.saves.find((entry) => entry.key === key);
    if (save) return { at: save.at, device: item.device, event: null };
  }
  return null;
}

/** Selecting a save leaves the diff, as the mockup does, and opens the preview
 * on the phone. */
export function selectSave(view: HistoryView, key: string): HistoryView {
  return { ...view, selected: key, showDiff: false, pane: "preview" };
}

export function backToList(view: HistoryView): HistoryView {
  return { ...view, pane: "list" };
}

export function toggleExpanded(view: HistoryView, key: string): HistoryView {
  const expanded = new Set(view.expanded);
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  return { ...view, expanded };
}

export function toggleDiff(view: HistoryView): HistoryView {
  return { ...view, showDiff: !view.showDiff };
}

export function showOlder(view: HistoryView): HistoryView {
  return { ...view, shown: view.shown + PERIODS_PER_PAGE };
}

export type VisibleHistory = {
  /** The list, newest first, cut after the last revealed period. */
  rows: HistoryItem[];
  /** Periods are loaded but still hidden: "Show older" just reveals them. */
  morePeriods: boolean;
};

/** Reveals periods newest first; a boundary row (marker, deletion, restore, gap) only
 * shows once every period above it is on screen, so it never arrives before its own
 * saves. */
export function visibleRows(items: HistoryItem[], shown: number): VisibleHistory {
  const periods = items.filter((item) => item.kind === "period").length;
  const rows: HistoryItem[] = [];
  let revealed = 0;
  for (const item of items) {
    if (item.kind === "period") {
      if (revealed >= shown) break;
      revealed++;
      rows.push(item);
      continue;
    }
    // A boundary only arrives with the saves under it, or at the end of the list.
    if (revealed < shown || revealed === periods) rows.push(item);
  }
  return { rows, morePeriods: periods > shown };
}

/** What the right pane shows, and the toolbar toggle it offers (none for
 * binaries: no diff to make). */
export function previewState(
  view: HistoryView,
  kind: VersionPreview["kind"],
): { mode: "diff" | "version"; toggle: string | null } {
  if (kind !== "text") return { mode: "version", toggle: null };
  return view.showDiff
    ? { mode: "diff", toggle: "Show version" }
    : { mode: "version", toggle: "Changes" };
}

export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** Line diff of the selected version against the current one: removed lines are
 * the version's own, added lines the current file's. The shared line alignment
 * (with the conflict review) does the work: the merger's dependency, no second
 * diff algorithm. */
export function changeLines(versionText: string, currentText: string): DiffLine[] {
  return alignLines(versionText, currentText).map(({ kind, text }) => {
    if (kind === "same") return { kind, text };
    return kind === "before"
      ? { kind: "remove" as const, text: `− ${text}` }
      : { kind: "add" as const, text: `+ ${text}` };
  });
}
