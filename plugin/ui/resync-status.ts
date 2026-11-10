/** #54: the resync state and the copy its surfaces read: the notice, the status bar tooltip,
 * the settings row and the button label. The notice itself and the run live in
 * resync-run.ts. No obsidian import (deno-tested). */
import type { ProgressInfo } from "../sync/recovery.ts";

export type ResyncState =
  /** `progress.total` 0: the rebuild has not read the file list yet. */
  | { phase: "running"; progress: ProgressInfo }
  /** `syncStopped`: the rebuild left no session behind, so this state IS the sync status. */
  | { phase: "failed"; reason: string; syncStopped: boolean };

/** The row name and the idle button label are the same words. */
export const RESYNC_ROW = "Resync from scratch";
export const RESYNC_ROW_DESC =
  "Download the whole vault from the server again. Use only when sync is broken.";
export const RESYNC_BUSY = "Resyncing…";
export const RESYNC_RETRY = "Try again";

export type ResyncCopy = { notice: string; tooltip: string; row: string };

/** A failed head list can be hundreds of hashes long: a status row and a notice are not. */
const REASON_MAX = 96;

function clip(reason: string): string {
  return reason.length <= REASON_MAX ? reason : `${reason.slice(0, REASON_MAX - 1)}…`;
}

/** The three surfaces' words, from the one state. */
export function resyncCopy(state: ResyncState): ResyncCopy {
  if (state.phase === "failed") {
    const reason = clip(state.reason);
    const notice = `Geode: resync stopped. ${reason}`;
    return { notice, tooltip: notice, row: `Resync stopped. ${reason}` };
  }
  const { current, total } = state.progress;
  if (total === 0) {
    return { notice: "Geode: resyncing", tooltip: "Geode: resyncing", row: "Resyncing." };
  }
  return {
    notice: `Geode: resyncing ${current} of ${total} files`,
    tooltip: `Geode: resyncing ${current} of ${total}`,
    row: `Resyncing: ${current} of ${total} files.`,
  };
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

/** #54 review: only a rebuild that LEFT sync stopped owns the sync status. One that
 * restarted a session hands the status back: the restarted session's own state (offline,
 * paused, a version refusal, a held delete) is then the truth, and the stop keeps its
 * reason for when nothing more important is going on. */
export function resyncStopsSync(
  state: ResyncState | null,
): state is Extract<ResyncState, { phase: "failed" }> {
  return state?.phase === "failed" && state.syncStopped;
}

export function resyncButtonText(state: ResyncState | null): string {
  if (state?.phase === "running") return RESYNC_BUSY;
  return state?.phase === "failed" ? RESYNC_RETRY : RESYNC_ROW;
}

/** The marker a rebuild writes before it can change a row: a crash leaves this as the reason. */
export const RESYNC_UNFINISHED = "Resync did not finish.";

/** Connection-level failures have no message worth showing: the approved copy names the
 * one thing the user can act on. Every other failure keeps its own message. */
const UNREACHABLE = /net::ERR_|Failed to fetch|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/;

export function resyncStopReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  // A crash mid rebuild leaves the marker without a reason: say that, never nothing.
  if (message === "") return RESYNC_UNFINISHED;
  return UNREACHABLE.test(message) ? "Server unreachable." : message;
}

export function resyncDoneNotice(updated: number): string {
  if (updated === 0) return "Geode: resync done. Nothing to update.";
  return `Geode: resync done. ${updated} file${updated === 1 ? "" : "s"} updated.`;
}

/** #54: progress renders at most about four times a second. The first count and the last
 * count always render, so a short run still shows both ends of it. */
export const RESYNC_RENDER_MS = 250;

export function resyncRenderDue(
  progress: ProgressInfo,
  lastRenderAt: number,
  now: number,
  renderedCount: number,
): boolean {
  return progress.current >= progress.total ||
    (progress.current > 0 && renderedCount === 0) ||
    now - lastRenderAt >= RESYNC_RENDER_MS;
}
