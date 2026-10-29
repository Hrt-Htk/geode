/** Pure sync-status row text for the settings tab: no obsidian import (safe for deno unit tests). */
import type { IconInput } from "./statusbar-icon.ts";
import { blockedCopy, describeVersionHint } from "../sync/version-state.ts";
import { pauseAgeColor } from "./pause.ts";
import { holdSentence } from "./mass-delete-review.ts";

export type SyncStatusInput = IconInput & {
  lastBackupAt: number;
  /** #560: a re-key is running on another device: sync paused, no commits. */
  rekeyInProgress?: boolean;
  /** #560: the vault's passphrase changed elsewhere: locked until re-unlocked. */
  rekeyElsewhere?: boolean;
};

export type StatusDot = "green" | "blue" | "grey" | "orange" | "red";

/** Dot colour class per status dot: the one mapping both the settings row and the activity footer use. */
export const DOT_CLASS: Record<StatusDot, string> = {
  green: "geode-sync-dot-green",
  blue: "geode-sync-dot-blue",
  grey: "geode-sync-dot-grey",
  orange: "geode-sync-dot-orange",
  red: "geode-sync-dot-red",
};

export type SyncStatusResult = {
  text: string;
  dot: StatusDot | null;
  /** #443: conflicts sit on their own line under the paused copy, not appended. */
  conflictText?: string;
};

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function describeSyncStatus(i: SyncStatusInput, now: number): SyncStatusResult {
  const backup = backupSuffix(i.lastBackupAt, now);

  if (!i.unlocked) {
    if (i.rekeyElsewhere) {
      return { text: `Passphrase changed elsewhere. Unlock to continue. ${backup}`, dot: "red" };
    }
    return { text: `Locked. Nothing syncs until you unlock. ${backup}`, dot: "grey" };
  }

  if (i.rekeyInProgress) {
    return {
      text: `Rekey in progress on another device. Sync is paused. ${backup}`,
      dot: "orange",
    };
  }

  const gated = describeGated(i, now, backup);
  if (gated) return gated;

  if (i.conflictCount > 0) {
    return {
      text: `${i.conflictCount} conflict${i.conflictCount > 1 ? "s" : ""} to review. ${backup}`,
      dot: "orange",
    };
  }

  if (
    (i.state === "live" || i.state === "syncing") &&
    i.syncingProgress && i.syncingProgress.current < i.syncingProgress.total
  ) {
    return {
      text:
        `Catching up: ${i.syncingProgress.current} of ${i.syncingProgress.total} changes. ${backup}`,
      dot: "blue",
    };
  }

  switch (i.state) {
    case "live":
      return describeLive(i, backup);

    case "syncing":
      return { text: `Catching up… ${backup}`, dot: "blue" };

    case "disconnected":
      return {
        text: `Offline. Retrying in ${Math.round(i.reconnectDelay / 1000)} s. ${backup}`,
        dot: "orange",
      };

    default:
      return { text: "Connecting…", dot: "grey" };
  }
}

/** The states where sync is deliberately not moving, in precedence order: the user pause,
 * then the server's version refusal (#628: nothing can sync, the fix is an update), then
 * the held mass delete (a decision, but it needs the connection the refusal withholds). */
function describeGated(
  i: SyncStatusInput,
  now: number,
  backup: string,
): SyncStatusResult | null {
  if (i.pausedAt > 0) return describePaused(i, now);
  if (i.versionStatus.kind === "blocked") {
    return { text: `${blockedCopy(i.versionStatus.side).row} ${backup}`, dot: "red" };
  }
  if (i.massDeleteHold) {
    return { text: holdSentence(i.massDeleteHold.files.length), dot: "orange" };
  }
  return null;
}

function describePaused(i: SyncStatusInput, now: number): SyncStatusResult {
  const pending = i.pendingCount + i.dirtyCount;
  const base = "Paused. Changes are kept locally and upload when you resume.";
  const result: SyncStatusResult = {
    text: pending > 0 ? `${base} ${pending} change${pending > 1 ? "s" : ""} waiting.` : base,
    dot: pauseAgeColor(i.pausedAt, now),
  };
  if (i.conflictCount > 0) {
    const n = i.conflictCount;
    result.conflictText = `${n} conflict${n > 1 ? "s" : ""} to review.`;
  }
  return result;
}

function describeLive(i: SyncStatusInput, backup: string): { text: string; dot: StatusDot | null } {
  const n = i.pendingCount + i.dirtyCount;
  if (n > 0) {
    return { text: `Uploading ${n} change${n > 1 ? "s" : ""}. ${backup}`, dot: "blue" };
  }
  if (i.droppedCount > 0) {
    const d = i.droppedCount;
    return { text: `${d} change${d > 1 ? "s" : ""} couldn't upload. ${backup}`, dot: "orange" };
  }
  // #529: compatible but different versions: sync keeps running, show the hint.
  if (i.versionStatus.kind === "hint") {
    return {
      text: describeVersionHint(i.versionStatus.own, i.versionStatus.server) ?? "",
      dot: "orange",
    };
  }
  if (i.lastBackupAt === 0) {
    return { text: "Not backed up yet.", dot: null };
  }
  return { text: `Up to date. ${backup}`, dot: "green" };
}

function backupSuffix(lastBackupAt: number, now: number): string {
  if (lastBackupAt === 0) return "Not backed up yet.";
  const age = now - lastBackupAt;
  if (age < MIN) return "Last backup just now.";
  if (age < HOUR) return `Last backup ${Math.floor(age / MIN)} min ago.`;
  if (age < DAY) return `Last backup ${Math.floor(age / HOUR)} h ago.`;
  return `Last backup ${Math.floor(age / DAY)} d ago.`;
}
