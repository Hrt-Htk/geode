// #462: one file's version chain → editing periods for the history modal.
// Pure and Obsidian-free: the input is the server's `VersionRecord` rows, the
// output is data plus the row copy (#464 stays a thin shell).

import type { VersionRecord } from "../../core/protocol.ts";
import { type HistorySegment, saveKey } from "../sync/history-fetch.ts";
import { deviceNameLabel, plural } from "./trash-format.ts";

/** One save inside a period. `key` is its identity in the window: a version
 * number repeats from name to name (#583). */
export type HistorySave = { key: string; version: number; at: number };

/** A burst of saves by one device on one calendar day. `device` is the display
 * label; `deviceId` is the raw id, so a row can resolve the name itself. */
export type HistoryPeriod = {
  kind: "period";
  deviceId: string;
  device: string;
  /** Oldest → newest, matching the expanded sub-version list. */
  saves: HistorySave[];
};

/** Retention boundary: compaction folded the versions older than the chain. */
export type HistoryGap = { kind: "gap" };

/** #583: the window crossed a rename here: the rows below live under `from`. */
export type HistoryMarker = { kind: "marker"; from: string };

/** #691: a deletion or a restore from trash: a one-line row between periods, like
 * the rename marker. `key` is the version's identity and `device` the name the user
 * gave it (null when the vault never saw the device, #687); the row copy is built at
 * render. A deletion has no content, so only a restore row is selectable. */
export type HistoryEvent = {
  kind: "event";
  event: "deleted" | "restored";
  device: string | null;
  at: number;
  key: string;
  version: number;
};

export type HistoryItem = HistoryPeriod | HistoryGap | HistoryMarker | HistoryEvent;

/** The chain fields this module reads; the server sends full version records. */
export type HistoryChainRow = Pick<
  VersionRecord,
  "version" | "created_at" | "device_id" | "compacted_range" | "deleted" | "restored"
>;

const PERIOD_GAP_MS = 15 * 60_000;

type Boundary = "same" | "split";

/** A window's names → history items, most recent first: one run of periods per
 * name, the deletion and restore rows between them (#691), a marker row where the
 * walk crossed a rename, a gap per name folded by compaction. */
export function buildHistory(
  segments: readonly HistorySegment[],
  deviceNames?: Map<string, string> | null,
): HistoryItem[] {
  const items: HistoryItem[] = [];
  segments.forEach((segment, index) => {
    items.push(...periods(segment.versions, segment.pathHash, deviceNames));
    // The link only exists because the walk read this name's note, and only then
    // is there an older name to show.
    if (segment.from !== null && segments[index + 1]) {
      items.push({ kind: "marker", from: segment.from });
    }
  });
  return items;
}

/** One name's versions → periods and event rows, most recent first, with its
 * retention gap. */
function periods(
  chain: HistoryChainRow[],
  pathHash: string,
  deviceNames?: Map<string, string> | null,
): HistoryItem[] {
  const rows = [...chain].sort((a, b) => b.version - a.version);
  const items: HistoryItem[] = [];
  let current: { deviceId: string; saves: HistorySave[] } | null = null;

  const close = () => {
    const period = current;
    if (!period) return;
    items.push({
      kind: "period",
      deviceId: period.deviceId,
      device: deviceNameLabel(period.deviceId, deviceNames),
      saves: period.saves.reverse(),
    });
    current = null;
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const event = eventKind(row);
    if (event) {
      close();
      items.push({
        kind: "event",
        event,
        device: deviceNames?.get(row.device_id)?.trim() || null,
        at: row.created_at,
        key: saveKey(pathHash, row.version),
        version: row.version,
      });
      continue;
    }
    current ??= { deviceId: row.device_id, saves: [] };
    current.saves.push({
      key: saveKey(pathHash, row.version),
      version: row.version,
      at: row.created_at,
    });
    const older = rows[i + 1];
    if (!older) continue;
    if (boundaryKind(row, older) === "same") continue;
    close();
  }
  close();
  if (rows.some((row) => row.compacted_range !== null)) items.push({ kind: "gap" });
  return items;
}

/** #691: the row a chain row shows as: a tombstone is a deletion, a version that came
 * back from the trash is a restore. Rename link rows never arrive here (`cutPage`). */
function eventKind(row: HistoryChainRow): HistoryEvent["event"] | null {
  if (row.deleted) return "deleted";
  return row.restored === true ? "restored" : null;
}

/** Whether `row` and `older` belong to one editing period. */
function boundaryKind(row: HistoryChainRow, older: HistoryChainRow): Boundary {
  if (row.device_id !== older.device_id) return "split";
  if (dayIndex(row.created_at) !== dayIndex(older.created_at)) return "split";
  if (row.created_at - older.created_at > PERIOD_GAP_MS) return "split";
  return "same";
}

/** "Today 14:02 to 14:20 · This laptop": the collapsed period row; a period whose
 * saves all land on one minute reads "Today 14:02 · This laptop". */
export function periodLabel(period: HistoryPeriod, now = Date.now()): string {
  const first = period.saves[0];
  const last = period.saves[period.saves.length - 1];
  const start = timeLabel(first.at);
  const end = timeLabel(last.at);
  const when = start === end ? start : `${start} to ${end}`;
  return `${dayLabel(first.at, now)} ${when} · ${period.device}`;
}

/** #691: "Restored from trash on Phone", "Deleted on Phone": what happened, and to a
 * device the vault knows. A name it never saw (a legacy restore, a revoked device) has no
 * device to name, so the words stay bare (#687). */
export function eventText(event: HistoryEvent["event"], device: string | null): string {
  const mark = event === "restored" ? "Restored from trash" : "Deleted";
  return device ? `${mark} on ${device}` : mark;
}

/** #691: "Today 14:06 · Deleted on Phone", "Today 14:08 · Restored from trash on Phone". */
export function eventLabel(event: HistoryEvent, now = Date.now()): string {
  const when = `${dayLabel(event.at, now)} ${timeLabel(event.at)}`;
  return `${when} · ${eventText(event.event, event.device)}`;
}

/** "1 save" / "9 saves": the period's count. */
export function savesLabel(count: number): string {
  return `${count} ${plural(count, "save")}`;
}

/** The retention boundary line under the oldest loaded period. */
export function gapLabel(): string {
  return "Older versions were merged after 30 days";
}

/** "14:02": a save's local 24-hour time. */
export function timeLabel(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today" / "Yesterday" / "3 days ago": the day part of a period row. */
function dayLabel(at: number, now: number): string {
  const days = dayIndex(now) - dayIndex(at);
  if (days <= 0) return "Today";
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar-day index; the rounding absorbs 23 h and 25 h DST days. */
function dayIndex(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return Math.round(d.getTime() / 86_400_000);
}
