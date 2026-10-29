// #435: the Conflicts review screen's view model, obsidian-free: the compact
// row's two lines, the Original / Conflict key (which file each color names,
// with a date and a time), the keep action each button maps to on this device,
// and the version comparison. A conflict file holds the losing edit that was set
// aside, so on the device it was created on the keep mapping inverts; the list
// and review windows stay thin shells.

import type { ConflictRow, ConflictSide } from "../sync/conflict-list.ts";
import type { ResolutionAction } from "../sync/conflict-resolve.ts";
import { timeLabel } from "./history-periods.ts";
import { alignLines } from "./line-diff.ts";
import { formatDay } from "./mass-delete-review.ts";

export const REVIEW_BUTTON = "Review";
export const OPEN_BOTH_LINK = "Open both";
export const BACK_BUTTON = "Back";
export const KEEP_ORIGINAL_BUTTON = "Keep original";
export const KEEP_CONFLICT_BUTTON = "Keep conflict";
export const KEEP_BOTH_BUTTON = "Keep both";
const ORIGINAL_LABEL = "Original";
const CONFLICT_LABEL = "Conflict";
export const NO_DATE = "No date";
export const LOADING_TEXT = "Loading…";
export const READ_FAILED = "Couldn't read this note.";
export const CONFLICT_GONE = "This conflict is no longer here.";

/** "Plan.md": the row's first line, the part that was cut off. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "Notes/": the row's second line; "" for a file at the vault root. */
export function folderLine(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut + 1);
}

/** "Review · Plan.md": the review window's title. */
export function reviewTitle(path: string): string {
  return `${REVIEW_BUTTON} · ${fileName(path)}`;
}

/** "21 Oct 2026, 14:05": never a bare clock time, so a stale conflict can be dated. */
export function dateStamp(at: number): string {
  return `${formatDay(at)}, ${timeLabel(at)}`;
}

export type VersionKey = {
  label: string;
  path: string;
  name: string;
  device: string;
  /** Date and time, or NO_DATE. */
  when: string;
};

/** The two versions by file: the original (the normal named file, the version
 * the server holds) and the conflict file (the edit that was set aside). */
export function versionSides(
  row: Pick<ConflictRow, "conflictFileIsMine" | "mine" | "theirs">,
): { original: ConflictSide; conflict: ConflictSide } {
  return row.conflictFileIsMine
    ? { original: row.theirs, conflict: row.mine }
    : { original: row.mine, conflict: row.theirs };
}

/** The header key: the two colored names, each with its device, date and time. */
export function reviewKeys(
  row: ConflictRow,
): { original: VersionKey; conflict: VersionKey } {
  const { original, conflict } = versionSides(row);
  const key = (label: string, path: string, side: ConflictSide): VersionKey => ({
    label,
    path,
    name: fileName(path),
    device: side.device,
    when: side.time === null ? NO_DATE : dateStamp(side.time),
  });
  return {
    original: key(ORIGINAL_LABEL, row.path, original),
    conflict: key(CONFLICT_LABEL, row.conflictPath, conflict),
  };
}

/** Which resolution each button runs: keep original keeps row.path's content,
 * keep conflict keeps row.conflictPath's: the mine/theirs pair inverts on the
 * device the conflict file was created on. Confirmed against planResolution. */
export function keepActions(
  row: Pick<ConflictRow, "conflictFileIsMine">,
): { original: ResolutionAction; conflict: ResolutionAction } {
  return row.conflictFileIsMine
    ? { original: "keep-theirs", conflict: "keep-mine" }
    : { original: "keep-mine", conflict: "keep-theirs" };
}

export type ComparedLine = { kind: "same" | "original" | "conflict"; text: string };

/** Lines in both versions stay plain; a line only one version has takes that
 * version's tag, so a spot both changed arrives as the two stacked variants. */
export function comparedLines(originalText: string, conflictText: string): ComparedLine[] {
  return alignLines(originalText, conflictText).map(({ kind, text }) => ({
    kind: kind === "before" ? "original" : kind === "after" ? "conflict" : "same",
    text,
  }));
}
