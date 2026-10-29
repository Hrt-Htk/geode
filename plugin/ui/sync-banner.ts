/** Pure degraded-sync banner copy: no obsidian import (safe for deno unit tests). */
import { serverHost } from "./server-host.ts";
import type { SyncStatusInput } from "./sync-status.ts";

export function describeErrorBanner(
  input: SyncStatusInput,
  now: number,
  serverUrl: string,
): { name: string; desc: string } | null {
  if (!input.unlocked) return null;
  // The version banner owns the blocked case; a non-blocking hint must not hide an outage.
  if (input.versionStatus.kind === "blocked") return null;
  // A user pause is deliberate: the disconnect it causes is not an outage.
  if (input.pausedAt > 0) return null;
  // #601: a held mass delete stops sync on purpose; the hold banner explains it, and
  // "cannot reach your server" underneath would be a lie.
  if (input.massDeleteHold) return null;

  if (input.offlineSince > 0 && now - input.offlineSince >= 10_000) {
    return {
      name: "Cannot reach your Geode server",
      desc: `Sync is paused until ${serverHost(serverUrl)} is reachable. Last attempt ${
        formatAttemptAge(input.lastAttemptAt, now)
      }.`,
    };
  }

  if (input.droppedCount > 0) {
    const n = input.droppedCount;
    return {
      name: "Some changes couldn't upload",
      desc: n > 1
        ? `${n} files failed to upload. They stay on this device.`
        : "1 file failed to upload. It stays on this device.",
    };
  }

  return null;
}

// An outage runs from the first disconnect until connected again; reconnect
// attempts ("connecting") don't restart it, so the grace and banner stay steady.
export function nextOfflineSince(prev: number, state: string, now: number): number {
  if (state === "disconnected") return prev || now;
  if (state === "connecting") return prev;
  return 0;
}

function formatAttemptAge(lastAttemptAt: number, now: number): string {
  if (!lastAttemptAt) return "just now";
  const s = Math.max(0, Math.round((now - lastAttemptAt) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
