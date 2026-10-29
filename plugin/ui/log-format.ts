import { type LogEntry } from "../plumbing/log.ts";

/** Level filter for the Logs section: All / Warnings / Errors. */
export type LogFilter = "all" | "warn" | "error";

export const LOG_FILTERS: ReadonlyArray<{ id: LogFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "warn", label: "Warnings" },
  { id: "error", label: "Errors" },
];

/** The log box renders at most this many newest lines. */
export const LOG_LINE_LIMIT = 200;

/** Filter log entries by level; "all" keeps everything (exact match per tab). */
export function filterLogEntries(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  if (filter === "all") return entries;
  return entries.filter((e) => e.level === filter);
}

/** User-facing connection word for a transport state. */
export function connectionLabel(state: string): string {
  switch (state) {
    case "live":
    case "connected":
      return "Connected";
    case "syncing":
      return "Syncing";
    case "connecting":
      return "Connecting";
    case "blocked":
      return "Blocked";
    default:
      return "Disconnected";
  }
}

/** "Connected · seq 1284 · 2 pending": one muted details line. */
export function logDetailsText(details: { state: string; seq: number; pending: number }): string {
  return `${details.state} · seq ${details.seq} · ${details.pending} pending`;
}

function stringifyField(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Build a single-line log entry string. */
export function formatLogLine(entry: LogEntry): string {
  const ts = new Date(entry.ts).toISOString().slice(11, 19);
  const base = `[${ts}] [${entry.level}] ${entry.msg}`;
  const keys = Object.keys(entry.fields);
  if (keys.length === 0) return base;
  const fields = keys.map((k) => `${k}=${stringifyField(entry.fields[k])}`).join(" ");
  return `${base} · ${fields}`;
}

/** Join log entries into a multi-line export string. Empty input → "". */
export function formatLogExport(entries: LogEntry[]): string {
  return entries.map((e) => formatLogLine(e)).join("\n");
}
