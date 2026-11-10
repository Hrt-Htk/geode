/** #54: the resync surfaces' one state and copy: the notice, the status bar tooltip, the
 * settings row and the button label all read from here. No obsidian import (deno-tested). */

/** `total` 0: the rebuild has not read the file list yet. */
export type ResyncState =
  | { phase: "running"; current: number; total: number }
  | { phase: "failed"; reason: string };

export const RESYNC_ROW_NAME = "Resync from scratch";
export const RESYNC_ROW_DESC =
  "Download the whole vault from the server again. Use only when sync is broken.";
export const RESYNC_BUTTON = "Resync from scratch";
export const RESYNC_BUSY_BUTTON = "Resyncing…";
export const RESYNC_RETRY_BUTTON = "Try again";

function counted(state: Extract<ResyncState, { phase: "running" }>): boolean {
  return state.total > 0;
}

/** The notice: it stays while the rebuild runs and its numbers move. */
export function resyncNoticeText(state: ResyncState): string {
  if (state.phase === "failed") return `Geode: resync stopped. ${state.reason}`;
  return counted(state)
    ? `Geode: resyncing ${state.current} of ${state.total} files`
    : "Geode: resyncing";
}

export function resyncTooltip(state: ResyncState): string {
  if (state.phase === "failed") return `Geode: resync stopped. ${state.reason}`;
  return counted(state)
    ? `Geode: resyncing ${state.current} of ${state.total}`
    : "Geode: resyncing";
}

export function resyncRowText(state: ResyncState): string {
  if (state.phase === "failed") return `Resync stopped. ${state.reason}`;
  return counted(state) ? `Resyncing: ${state.current} of ${state.total} files.` : "Resyncing.";
}

export function resyncRowDot(state: ResyncState): "blue" | "orange" {
  return state.phase === "failed" ? "orange" : "blue";
}

export function resyncIcon(state: ResyncState): {
  icon: string;
  color: string;
  spin?: boolean;
} {
  return state.phase === "failed"
    ? { icon: "triangle-alert", color: "geode-statusbar-error" }
    : { icon: "refresh-cw", color: "geode-statusbar-syncing", spin: true };
}

export function resyncButtonText(state: ResyncState | null): string {
  if (state?.phase === "running") return RESYNC_BUSY_BUTTON;
  return state?.phase === "failed" ? RESYNC_RETRY_BUTTON : RESYNC_BUTTON;
}

/** Connection-level failures have no message worth showing: the approved copy names the
 * one thing the user can act on. Every other failure keeps its own message. */
const UNREACHABLE = /net::ERR_|Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/;

export function resyncStopReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return UNREACHABLE.test(message) ? "Server unreachable." : message;
}

export function resyncDoneNotice(updated: number): string {
  if (updated === 0) return "Geode: resync done. Nothing to update.";
  return `Geode: resync done. ${updated} file${updated === 1 ? "" : "s"} updated.`;
}
