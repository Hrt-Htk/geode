/** Pure status-icon resolution: no obsidian import (safe for deno unit tests). */
import { blockedCopy, type VersionStatus } from "../sync/version-state.ts";
import type { MassDeleteHold } from "../sync/mass-delete-hold.ts";
import { pauseAgeColor, pauseTooltip } from "./pause.ts";
import { holdSentence } from "./mass-delete-review.ts";

export type IconState = {
  icon: string;
  color: string;
  tooltip: string;
  spin?: boolean;
};

// #420: post-ack green hold (no spin→green→spin flicker while typing).
const GREEN_HOLD_MS = 1_000;

export const COLOR_CLASSES = [
  "geode-statusbar-locked",
  "geode-statusbar-ok",
  "geode-statusbar-syncing",
  "geode-statusbar-dirty",
  "geode-statusbar-error",
  "geode-statusbar-spin",
  "geode-statusbar-paused-grey",
  "geode-statusbar-paused-orange",
  "geode-statusbar-paused-red",
  "geode-statusbar-conflict",
  "geode-statusbar-hold",
] as const;

export type IconInput = {
  unlocked: boolean;
  versionStatus: VersionStatus;
  conflictCount: number;
  state: string;
  pendingCount: number;
  dirtyCount: number;
  /** Tooltip source: stamped on connects, drains and commit acks. */
  lastSyncTime: number;
  /** Commit-ack source for the green hold: stamped only on an outbound commit ack. */
  lastAckAt: number;
  syncingProgress: { current: number; total: number } | null;
  reconnectDelay: number;
  /** ms timestamp the transport went disconnected; 0 = online. */
  offlineSince: number;
  /** ms timestamp of the last failed connect attempt; 0 = none. */
  lastAttemptAt: number;
  droppedCount: number;
  /** ms timestamp of the user pause; 0 = not paused. */
  pausedAt: number;
  /** #601: the held mass delete: sync waits for a decision, not for the server. */
  massDeleteHold: MassDeleteHold | null;
  now: number;
  /** Highest per-path commit retry count in flight (commit-queue retryCounts). */
  maxRetries: number;
};

export function resolveIcon(i: IconInput): IconState {
  if (!i.unlocked) {
    return {
      icon: "lock-keyhole",
      color: "geode-statusbar-locked",
      tooltip: "Geode: locked",
    };
  }

  if (i.pausedAt > 0) return pausedIcon(i.pausedAt, i.now);

  // #628: a refused device cannot sync at all and the fix is an update, so the red
  // refusal outranks the hold (whose decision needs the connection it refuses).
  if (i.versionStatus.kind === "blocked") {
    return {
      icon: "triangle-alert",
      color: "geode-statusbar-error",
      tooltip: blockedCopy(i.versionStatus.side).tooltip,
    };
  }

  // #601: a held mass delete outranks conflicts and the transport states: it is the one
  // state that needs a decision before sync moves at all.
  if (i.massDeleteHold) {
    return {
      icon: "file-warning",
      color: "geode-statusbar-hold",
      tooltip: holdSentence(i.massDeleteHold.files.length),
    };
  }

  // #432: calmer conflicts icon: git-merge in orange; red stays reserved for
  // disconnect / version errors. Zero conflicts falls through to the synced icon.
  if (i.conflictCount > 0) {
    return {
      icon: "git-merge",
      color: "geode-statusbar-conflict",
      tooltip: `Geode: ${i.conflictCount} conflict${i.conflictCount > 1 ? "s" : ""}`,
    };
  }

  switch (i.state) {
    case "live":
      return liveIcon(i);

    case "syncing":
      return {
        icon: "refresh-cw",
        color: "geode-statusbar-syncing",
        tooltip: i.syncingProgress
          ? `Geode: syncing... ${i.syncingProgress.current}/${i.syncingProgress.total}`
          : "Geode: syncing...",
        spin: true,
      };

    case "disconnected":
      return {
        icon: "refresh-cw-off",
        color: "geode-statusbar-error",
        tooltip: `Geode: offline · Retry in ${Math.round(i.reconnectDelay / 1000)}s`,
      };

    default:
      return {
        icon: "refresh-cw",
        color: "geode-statusbar-syncing",
        tooltip: "Geode: connecting...",
        spin: true,
      };
  }
}

function liveIcon(i: IconInput): IconState {
  // Inbound apply backlog takes precedence over the synced checkmark: the
  // transport goes live as soon as all versions are *received*, before the
  // replay buffer drains to disk (#319).
  if (i.syncingProgress && i.syncingProgress.current < i.syncingProgress.total) {
    return {
      icon: "refresh-cw",
      color: "geode-statusbar-syncing",
      tooltip: `Geode: applying ${i.syncingProgress.current}/${i.syncingProgress.total}`,
      spin: true,
    };
  }
  const hasWork = i.pendingCount > 0 || i.dirtyCount > 0;
  if (hasWork) {
    // #420: orange after 3 failed tries.
    if (i.maxRetries >= 3) {
      return {
        icon: "refresh-cw",
        color: "geode-statusbar-dirty",
        tooltip: `Geode: upload failing (retry ${i.maxRetries})`,
        spin: true,
      };
    }
    // #420: the ack's green hold keeps showing even with new work; only lastAckAt starts it.
    if (i.lastAckAt > 0 && i.now - i.lastAckAt < GREEN_HOLD_MS) {
      return {
        icon: "circle-check",
        color: "geode-statusbar-ok",
        tooltip: `Geode: synced · Last synced: ${formatAgo(i.lastSyncTime, i.now)}`,
      };
    }
    if (i.pendingCount > 0) {
      return {
        icon: "refresh-cw",
        color: "geode-statusbar-ok",
        tooltip: `Geode: pushing (${i.pendingCount})`,
        spin: true,
      };
    }
    return {
      icon: "refresh-cw",
      color: "geode-statusbar-dirty",
      tooltip: `Geode: ${i.dirtyCount} change${i.dirtyCount > 1 ? "s" : ""} pending`,
      spin: true,
    };
  }
  return {
    icon: "circle-check",
    color: "geode-statusbar-ok",
    tooltip: `Geode: synced · Last synced: ${formatAgo(i.lastSyncTime, i.now)}`,
  };
}

function pausedIcon(pausedAt: number, now: number): IconState {
  return {
    icon: "pause-circle",
    color: `geode-statusbar-paused-${pauseAgeColor(pausedAt, now)}`,
    tooltip: pauseTooltip(pausedAt, now),
  };
}

function formatAgo(ts: number, now: number): string {
  if (!ts) return "never";
  const diff = (now - ts) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}
