/** #601: the mass-delete guard: threshold, settings-field validation, decision split. */

export const MASS_DELETE_MIN_FILES = 20;
export const MASS_DELETE_MIN_PERCENT = 25;

/** #601: a decision, and a rebuild, which is the restore-everything decision: needs the user
 * pause lifted first. */
export const MASS_DELETE_NEEDS_RESUME =
  "mass delete decision needs sync resumed: Resume sync first";

/** A tracked path the guard found missing, with the mtime of its last synced state. */
export interface HeldFile {
  path: string;
  mtime: number;
}

/** The persisted hold (data.json, like `pauseAt`): what went missing, when, and against
 * how many tracked files: the flag a restart reads to stay offline. */
export interface MassDeleteHold {
  files: HeldFile[];
  totalTracked: number;
  detectedAt: number;
}

/** #601: the guard the reconciler runs: the two numbers (read on every pass, so the
 * settings row applies without a restart) and what to do when it trips. */
export interface MassDeleteGuard {
  thresholds: () => { minFiles: number; minPercent: number };
  onHold: (held: HeldFile[], totalTracked: number) => void | Promise<void>;
}

/** The hold a tripped guard records: the first trip wins, so a pass that overlapped it
 * cannot rewrite the files or the timestamp. Null = already held. */
export function holdOnTrip(
  settings: { massDeleteHold: MassDeleteHold | null },
  files: HeldFile[],
  totalTracked: number,
  now: number,
): MassDeleteHold | null {
  if (settings.massDeleteHold) return null;
  const hold: MassDeleteHold = { files, totalTracked, detectedAt: now };
  settings.massDeleteHold = hold;
  return hold;
}

/** Hold only when BOTH trip: the count floor keeps small vaults from holding on every
 * startup, the percentage keeps a big vault's deletes from sliding under the floor.
 * Strictly greater, in integer arithmetic so the exact-percent boundary cannot round. */
export function shouldHoldMassDelete(
  unpairedDeletes: number,
  totalTracked: number,
  minFiles: number,
  minPercent: number,
): boolean {
  return unpairedDeletes >= minFiles && unpairedDeletes * 100 > totalTracked * minPercent;
}

/** A settings text field → the last valid value when the input is not a whole number in
 * [min, max] (the Trash retention field's behaviour). */
export function thresholdFromInput(
  raw: string,
  lastValid: number,
  min: number,
  max: number,
): number {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min && value <= max ? value : lastValid;
}

/** What a decision does with the held list: an explicit delete wins (once confirmed still
 * gone), a path back on disk is left alone, nothing else is restored over a live file. */
export async function planMassDeleteDecision(
  held: HeldFile[],
  deletePaths: string[],
  exists: (path: string) => Promise<boolean>,
): Promise<{ restore: string[]; remove: string[] }> {
  const selected = new Set(deletePaths);
  const restore: string[] = [];
  const remove: string[] = [];
  for (const { path } of held) {
    if (await exists(path)) continue;
    (selected.has(path) ? remove : restore).push(path);
  }
  return { restore, remove };
}
