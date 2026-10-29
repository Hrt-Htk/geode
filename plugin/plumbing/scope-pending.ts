import {
  configScopeForPath,
  isPathInScope,
  otherCatchUpEntry,
  PluginSettings,
} from "./settings-types.ts";
import { log } from "./log.ts";

// #342: pending folder re-includes (and #454: config-category re-enables).
// Switching a folder/category back on records its path prefixes here (persisted
// per-device in data.json) before the server-head catch-up runs; a failed
// catch-up keeps them pending and the next reconnect retries. Only once
// catch-up succeeds are they cleared: until then the reconciler treats the
// paths as out of scope, so a local delete made while they were excluded can
// never propagate (the catch-up restores the server head instead).

export interface PendingCatchUpSink {
  settings: PluginSettings;
  saveSettings: () => Promise<void>;
  catchUpFolders: (folders: string[]) => Promise<void>;
}

/** #342/#454: true if `path` is covered by a catch-up entry: folder/file
 * entries match by path (files exact, dirs by prefix), the `other` sentinel
 * matches by classifier. */
export function isPathInCatchUp(path: string, entries: string[], configDir: string): boolean {
  const other = otherCatchUpEntry(configDir);
  return entries.some((f) =>
    f === other
      ? configScopeForPath(path, configDir) === "other"
      : f.endsWith("/")
      ? path.startsWith(f)
      : path === f
  );
}

/** True while a path is under a pending re-include: no reconciler ops (create,
 * modify, delete) may be emitted for it. */
export function isPendingScope(path: string, settings: PluginSettings, configDir: string): boolean {
  return isPathInCatchUp(path, settings.pendingCatchUpFolders, configDir);
}

/** Switch a folder/category back on: record its path prefixes as pending
 * (persisted), then catch up to the server heads. On failure the prefixes stay
 * pending and the caller's notify shows a notice; the next reconnect retries. */
export async function catchUpOrDefer(
  sink: PendingCatchUpSink,
  folders: string[],
  notify: (message: string) => void,
): Promise<void> {
  const pending = sink.settings.pendingCatchUpFolders;
  for (const f of folders) {
    if (!pending.includes(f)) pending.push(f);
  }
  await sink.saveSettings();
  await retryPendingCatchUp(sink, notify);
}

/** Retry every pending re-include (session start / reconnect). Clears the
 * pending list once every head applied. */
export async function retryPendingCatchUp(
  sink: PendingCatchUpSink,
  notify?: (message: string) => void,
): Promise<void> {
  const pending = sink.settings.pendingCatchUpFolders;
  if (pending.length === 0) return;
  try {
    await sink.catchUpFolders(pending);
    sink.settings.pendingCatchUpFolders = [];
    await sink.saveSettings();
  } catch (err) {
    log.warn("folder catch up failed; kept pending for retry", {
      folders: pending,
      error: err instanceof Error ? err.message : String(err),
    });
    notify?.(
      "Geode: could not load the changes from the server yet. It will retry automatically.",
    );
  }
}

/** #342: a folder was switched off: drop it (and everything under it) from the
 * pending list so no catch-up runs for an excluded folder. */
export async function dropPendingCatchUp(
  settings: PluginSettings,
  folder: string,
  saveSettings: () => Promise<void>,
): Promise<void> {
  const next = settings.pendingCatchUpFolders.filter(
    (f) => !(f === folder || f.startsWith(folder)),
  );
  if (next.length === settings.pendingCatchUpFolders.length) return;
  settings.pendingCatchUpFolders = next;
  await saveSettings();
}

/** #454: a category was switched off: drop its path prefixes from the pending
 * list so no catch-up runs for an excluded category (mirrors the folder case).
 * Exact entries only, so a sibling category's prefixes stay pending. */
export async function dropPendingEntries(
  settings: PluginSettings,
  entries: string[],
  saveSettings: () => Promise<void>,
): Promise<void> {
  const drop = new Set(entries);
  const next = settings.pendingCatchUpFolders.filter((f) => !drop.has(f));
  if (next.length === settings.pendingCatchUpFolders.length) return;
  settings.pendingCatchUpFolders = next;
  await saveSettings();
}

export interface PendingMoveOut {
  oldPath: string;
  destFolder: string;
  /** #584: the exact name the file was parked under, so the move can be linked to it
   * when it resolves. Absent on entries written before it existed (folder only). */
  destPath?: string;
}

/** Upper bound on pendingMoveOuts; oldest entries are dropped past it. A dropped #584
 * entry leaves its row closed: the old name is never linked, and its versions stay
 * skipped (no resurrection): the file's history is still reachable from that name. */
export const MOVE_OUT_CAP = 1000;

/** The folder a path sits in ("Archive/a.md" → "Archive/", a root file → ""). */
export function destFolderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
}

/** #584: the parked move that ends at `path`: this device's file sits in an excluded
 * folder under that name. */
export function parkedMoveAt(
  entries: PendingMoveOut[],
  path: string,
): PendingMoveOut | undefined {
  return entries.find((m) => m.destPath === path);
}

/** #584: the file at `path` was moved out of sync and has not come back. */
export function isParkedMove(entries: PendingMoveOut[], path: string): boolean {
  return entries.some((m) => m.oldPath === path);
}

/** The parked list after one park/re-point, plus the entries it displaced. */
export interface MoveOutUpdate {
  entries: PendingMoveOut[];
  /** Parked files this one overwrote at its destination: they are gone from disk, so
   * their rows must be released for the reconciler to tombstone. */
  displaced: PendingMoveOut[];
}

/** #584: record a move into an excluded folder: one parked move per file and per
 * destination (a move onto a parked name overwrites that file). */
export function parkMoveOut(
  entries: PendingMoveOut[],
  parked: PendingMoveOut,
): MoveOutUpdate {
  const displaced = entries.filter((m) =>
    m.oldPath !== parked.oldPath && m.destPath === parked.destPath
  );
  const kept = entries.filter((m) =>
    m.oldPath !== parked.oldPath && m.destPath !== parked.destPath
  );
  return { entries: [...kept, parked], displaced };
}

/** #584: a move inside the excluded area re-points the parked destination. Null when
 * nothing was parked at `from` (an ordinary out-of-scope move). */
export function repointMoveOut(
  entries: PendingMoveOut[],
  from: string,
  to: string,
): MoveOutUpdate | null {
  const parked = parkedMoveAt(entries, from);
  if (!parked) return null;
  return parkMoveOut(entries.filter((m) => m !== parked), {
    ...parked,
    destPath: to,
    destFolder: destFolderOf(to),
  });
}

export interface PruneMoveOutCtx {
  excludedFolders: string[];
  includedFolders: string[];
  pendingCatchUpFolders: string[];
  /** Folders whose catch-up is running now: their moves complete regardless of
   * the pending guard (a running catch-up clears pending on success). */
  reIncludedFolders: string[];
  hasRow: (oldPath: string) => boolean;
}

/** #342: bound pendingMoveOuts. An entry completes once its destination is back in
 * scope: re-included, or excluded no longer for any reason, and is dropped as dead
 * weight once its source row is gone. What completing means is the caller's: today the
 * source row is released to the reconciler, while a parked entry with a `destPath`
 * resolves as the rename it always was (#584). The list is capped at MOVE_OUT_CAP,
 * oldest first. */
export function pruneMoveOuts(
  entries: PendingMoveOut[],
  ctx: PruneMoveOutCtx,
): { remaining: PendingMoveOut[]; completed: PendingMoveOut[]; dropped: PendingMoveOut[] } {
  const remaining: PendingMoveOut[] = [];
  const completed: PendingMoveOut[] = [];
  const dropped: PendingMoveOut[] = [];
  for (const m of entries) {
    const reIncluded = ctx.reIncludedFolders.some(
      (f) => m.destFolder === f || m.destFolder.startsWith(f),
    );
    const inScope = isPathInScope(m.destFolder, ctx.excludedFolders, ctx.includedFolders);
    const pending = ctx.pendingCatchUpFolders.some(
      (f) => m.destFolder === f || m.destFolder.startsWith(f),
    );
    if (reIncluded || (inScope && !pending)) {
      completed.push(m);
    } else if (!ctx.hasRow(m.oldPath)) {
      dropped.push(m);
    } else {
      remaining.push(m);
    }
  }
  if (remaining.length > MOVE_OUT_CAP) {
    const overflow = remaining.length - MOVE_OUT_CAP;
    log.warn("dropping oldest pendingMoveOuts", { dropped: overflow });
    dropped.push(...remaining.splice(0, overflow));
  }
  return { remaining, completed, dropped };
}
