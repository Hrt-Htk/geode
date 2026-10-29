// #431: sync activity: per-file latest-activity index, persisted across
// restarts. obsidian-free (deno-testable): recording, per-file collapse,
// save-count aggregation, day buckets, All/Conflicts/Errors filters, file-name
// search, relative vs absolute time. No I/O here: `now` is injected and
// persistence is serialize/parse; the ActivityRecorder wires throttled writes.

export type ActivityKind =
  | "upload"
  | "download"
  | "merge"
  | "delete"
  | "restored"
  | "restore"
  | "conflict"
  | "error"
  | "resolved";
export type ActivityFilter = "all" | "conflict" | "error";
export type DayBucket = "today" | "yesterday" | "earlier";

export interface ActivityEntry {
  path: string;
  kind: ActivityKind;
  /** Remote device id for remote-origin events (null for own events): lets a
   *  later device list (#433) re-resolve names. */
  deviceId: string | null;
  /** Display label resolved at record time (own name or a neutral remote label). */
  deviceLabel: string;
  /** Error rows show the cause instead of a device. */
  cause: string | null;
  /** ms epoch of the latest event for this path. */
  at: number;
  /** Consecutive upload count: the "N saves" aggregation. */
  saves: number;
}

export interface ActivityInput {
  path: string;
  kind: ActivityKind;
  deviceId?: string | null;
  cause?: string | null;
  /** Pre-resolved label (resolved rows: "kept Phone's version" / "kept both"). */
  label?: string;
}

/** Callback handed down the sync path; the recorder resolves labels internally. */
export type ActivityRecord = (input: ActivityInput) => void;

export interface ActivityGroup {
  bucket: DayBucket;
  label: string;
  rows: ActivityRow[];
}

/** Resolve a row's device label against a live deviceId→name map (fetched when
 *  the modal opens). Own rows (null id) keep their label; unknown ids: e.g.
 *  a revoked device: keep the neutral label. */
export function resolveDeviceLabel(entry: ActivityEntry, names: Map<string, string>): string {
  if (entry.deviceId === null) return entry.deviceLabel;
  const remote = names.get(entry.deviceId) ?? REMOTE_LABEL;
  if (entry.kind === "merge" || entry.kind === "conflict") {
    return `${entry.deviceLabel.split(" & ")[0]} & ${remote}`;
  }
  return remote;
}

export interface ActivityRow {
  entry: ActivityEntry;
  name: string;
  verb: string;
  icon: string;
  /** "" for ordinary rows, "mod-conflict" / "mod-error" for distinct colors. */
  mod: string;
  detail: string;
  time: string;
  absolute: boolean;
}

export const ACTIVITY_CAP = 500;
const REMOTE_LABEL = "Another device";
const OWN_LABEL = "This device";
const PERSIST_THROTTLE_MS = 2000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const KIND_META: Record<
  ActivityKind,
  { icon: string; mod: string; absolute: boolean; verb: string }
> = {
  upload: { icon: "upload-cloud", mod: "", absolute: false, verb: "Uploaded" },
  download: { icon: "download-cloud", mod: "", absolute: false, verb: "Downloaded" },
  merge: { icon: "git-merge", mod: "", absolute: false, verb: "Merged" },
  delete: { icon: "trash-2", mod: "", absolute: true, verb: "Deleted" },
  // #593: a local delete overridden by a remote edit, kept visible.
  restored: { icon: "rotate-ccw", mod: "", absolute: true, verb: "Restored after your delete" },
  // #465: a past version restored as a new head version.
  restore: { icon: "rotate-ccw", mod: "", absolute: true, verb: "Restored" },
  conflict: { icon: "triangle-alert", mod: "mod-conflict", absolute: true, verb: "Conflict" },
  error: { icon: "alert-circle", mod: "mod-error", absolute: true, verb: "Error" },
  resolved: { icon: "git-merge", mod: "", absolute: true, verb: "Resolved" },
};

export function recordActivity(
  entries: Map<string, ActivityEntry>,
  input: ActivityInput,
  ctx: { now: number; deviceName: string; myDeviceId: string },
): void {
  const at = ctx.now;
  const existing = entries.get(input.path);
  // A conflict entry carries the remote device id the Conflicts view (#432)
  // resolves the "theirs" side from; a later apply of the same path must not
  // clobber it with a download row: nor with #593's restore row.
  if (existing?.kind === "conflict" && (input.kind === "download" || input.kind === "restored")) {
    return;
  }
  if (input.kind === "upload") {
    if (existing && existing.kind === "upload") {
      existing.at = at;
      existing.saves += 1;
    } else {
      entries.set(input.path, {
        path: input.path,
        kind: "upload",
        deviceId: null,
        deviceLabel: ownLabel(ctx.deviceName),
        cause: null,
        at,
        saves: 1,
      });
    }
    trimEntries(entries);
    return;
  }
  entries.set(input.path, {
    path: input.path,
    kind: input.kind,
    deviceId: input.deviceId ?? null,
    deviceLabel: input.label ?? deviceLabel(input, ctx),
    cause: input.cause ?? null,
    at,
    saves: 0,
  });
  trimEntries(entries);
}

function deviceLabel(
  input: ActivityInput,
  ctx: { deviceName: string; myDeviceId: string },
): string {
  const own = ownLabel(ctx.deviceName);
  if (input.kind === "merge" || input.kind === "conflict") {
    return `${own} & ${remoteLabel(input.deviceId, ctx.myDeviceId, own)}`;
  }
  if (input.deviceId === null || input.deviceId === undefined) return own;
  return remoteLabel(input.deviceId, ctx.myDeviceId, own);
}

function ownLabel(deviceName: string): string {
  return deviceName.trim() ? deviceName : OWN_LABEL;
}

function remoteLabel(
  deviceId: string | null | undefined,
  myDeviceId: string,
  own: string,
): string {
  return deviceId === myDeviceId ? own : REMOTE_LABEL;
}

function trimEntries(entries: Map<string, ActivityEntry>): void {
  if (entries.size <= ACTIVITY_CAP) return;
  let oldestPath: string | null = null;
  let oldestAt = Infinity;
  for (const [path, e] of entries) {
    if (e.at < oldestAt) {
      oldestAt = e.at;
      oldestPath = path;
    }
  }
  if (oldestPath !== null) entries.delete(oldestPath);
}

export function applyActivityFilter(
  entries: Iterable<ActivityEntry>,
  filter: ActivityFilter,
): ActivityEntry[] {
  const out = [...entries];
  if (filter === "conflict") return out.filter((e) => e.kind === "conflict");
  if (filter === "error") return out.filter((e) => e.kind === "error");
  return out;
}

export function buildRows(
  entries: Iterable<ActivityEntry>,
  opts: { filter: ActivityFilter; query: string; now: number; deviceNames?: Map<string, string> },
): ActivityGroup[] {
  let list = applyActivityFilter(entries, opts.filter);
  const q = opts.query.trim().toLowerCase();
  if (q) list = list.filter((e) => e.path.toLowerCase().includes(q));
  list.sort((a, b) => b.at - a.at);

  const groups: ActivityGroup[] = [];
  for (const bucket of ["today", "yesterday", "earlier"] as DayBucket[]) {
    const rows = list
      .filter((e) => dayBucket(e.at, opts.now) === bucket)
      .map((entry) => buildRow(entry, opts.now, opts.deviceNames));
    if (rows.length > 0) groups.push({ bucket, label: BUCKET_LABELS[bucket], rows });
  }
  return groups;
}

const BUCKET_LABELS: Record<DayBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

function dayBucket(at: number, now: number): DayBucket {
  const today = startOfDay(now);
  if (at >= today) return "today";
  if (at >= today - DAY_MS) return "yesterday";
  return "earlier";
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildRow(
  entry: ActivityEntry,
  now: number,
  deviceNames?: Map<string, string>,
): ActivityRow {
  const meta = KIND_META[entry.kind];
  const parts = [meta.verb];
  if (entry.kind === "error") {
    if (entry.cause) parts.push(entry.cause);
  } else {
    parts.push(deviceNames ? resolveDeviceLabel(entry, deviceNames) : entry.deviceLabel);
  }
  if (entry.kind === "upload" && entry.saves >= 2) parts.push(`${entry.saves} saves`);
  return {
    entry,
    name: entry.path.split("/").pop() ?? entry.path,
    verb: meta.verb,
    icon: meta.icon,
    mod: meta.mod,
    detail: parts.join(" · "),
    absolute: meta.absolute,
    time: meta.absolute ? clockTime(entry.at) : relativeTime(entry.at, now),
  };
}

function clockTime(at: number): string {
  const d = new Date(at);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function relativeTime(at: number, now: number): string {
  const bucket = dayBucket(at, now);
  if (bucket === "yesterday") return "yesterday";
  const minutes = Math.floor((now - at) / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (bucket === "today") return `${hours} h ago`;
  const days = Math.max(1, Math.floor(hours / 24));
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function serializeActivity(entries: Iterable<ActivityEntry>): string {
  return JSON.stringify({ version: 1, entries: [...entries] });
}

/** Torn or missing data returns null → the caller treats it as an empty log. */
export function parseActivity(json: string | null): ActivityEntry[] | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as { entries?: unknown };
    if (!Array.isArray(data.entries)) return null;
    const out: ActivityEntry[] = [];
    for (const raw of data.entries) {
      const e = raw as Record<string, unknown>;
      if (
        typeof e.path !== "string" ||
        typeof e.kind !== "string" ||
        !(e.kind in KIND_META) ||
        typeof e.at !== "number"
      ) {
        return null;
      }
      out.push({
        path: e.path,
        kind: e.kind as ActivityKind,
        deviceId: typeof e.deviceId === "string" ? e.deviceId : null,
        deviceLabel: typeof e.deviceLabel === "string" ? e.deviceLabel : "",
        cause: typeof e.cause === "string" ? e.cause : null,
        at: e.at,
        saves: typeof e.saves === "number" ? e.saves : 0,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Plugin-scope recorder: throttled trailing writes, torn-load → empty. */
export class ActivityRecorder {
  readonly entries = new Map<string, ActivityEntry>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ctx: {
      now: () => number;
      deviceName: () => string;
      myDeviceId: () => string;
      persist: (json: string) => void;
    },
  ) {}

  record(input: ActivityInput): void {
    recordActivity(this.entries, input, {
      now: this.ctx.now(),
      deviceName: this.ctx.deviceName(),
      myDeviceId: this.ctx.myDeviceId(),
    });
    this.schedulePersist();
  }

  load(json: string | null): void {
    this.entries.clear();
    const parsed = parseActivity(json);
    if (!parsed) return;
    for (const e of parsed) this.entries.set(e.path, e);
  }

  clear(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.entries.clear();
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.ctx.persist(serializeActivity(this.entries.values()));
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.ctx.persist(serializeActivity(this.entries.values()));
      } catch {
        // non-critical: a torn file is tolerated as an empty log
      }
    }, PERSIST_THROTTLE_MS);
  }
}
