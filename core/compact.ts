// Pure, dependency-free version compaction planner.
// Drops old versions (older than `floorMs`) down to one checkpoint per edited
// calendar day, keeping root (earliest) and head (latest) and all recent
// versions. Never renumbers `version` or rewrites `parent`; folded ranges are
// recorded as `{start}-{end}` labels on surviving checkpoints.

export interface CompactRow {
  version: number;
  created_at: number; // ms epoch
  /** #583: 0 = ordinary version; a marker (1) or note (2) is kept forever. */
  rename_mark?: number;
}

export interface CompactionPlan {
  keep: number[]; // versions to retain (ascending)
  drop: number[]; // versions to delete
  ranges: Array<{ version: number; label: string }>; // compacted_range to SET on checkpoints
}

function defaultDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/** The last old version of each calendar day: the checkpoint that day folds into. */
function lastVersionPerDay(
  rows: CompactRow[],
  floor: number,
  dayKey: (ts: number) => string,
): number[] {
  const lastOfDay = new Map<string, number>();
  for (const r of rows) {
    if (r.created_at >= floor) continue;
    const prev = lastOfDay.get(dayKey(r.created_at));
    if (prev === undefined || r.version > prev) lastOfDay.set(dayKey(r.created_at), r.version);
  }
  return [...lastOfDay.values()];
}

export function planCompaction(
  rows: CompactRow[],
  now: number,
  opts: { floorMs: number; dayKey?: (ts: number) => string },
): CompactionPlan {
  const floorMs = opts.floorMs;
  const dayKey = opts.dayKey ?? defaultDayKey;
  const floor = now - floorMs;

  if (rows.length <= 1) {
    return { keep: rows.map((r) => r.version), drop: [], ranges: [] };
  }

  const root = rows[0].version;
  const head = rows[rows.length - 1].version;

  // Recent versions are kept outright; old ones fold to one checkpoint per day.
  const keepSet = new Set<number>([root, head, ...lastVersionPerDay(rows, floor, dayKey)]);
  for (const r of rows) {
    // #583: a marker or note is kept forever: a reused name makes it an interior
    // row, and losing it loses the window's boundary.
    if (r.rename_mark || r.created_at >= floor) keepSet.add(r.version);
  }

  const keep = [...keepSet].sort((a, b) => a - b);
  const drop = rows.filter((r) => !keepSet.has(r.version)).map((r) => r.version);

  // Emit a range for each kept version whose span since the previous kept
  // version actually folded at least one dropped version.
  const ranges: CompactionPlan["ranges"] = [];
  for (let i = 1; i < keep.length; i++) {
    const prev = keep[i - 1];
    const cur = keep[i];
    let folded = 0;
    for (const r of rows) {
      if (r.version > prev && r.version < cur && !keepSet.has(r.version)) folded++;
    }
    if (folded >= 1) ranges.push({ version: cur, label: `${prev + 1}-${cur}` });
  }

  return { keep, drop, ranges };
}
