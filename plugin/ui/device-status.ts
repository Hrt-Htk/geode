// #433: obsidian-free device row text. Renders the Devices view rows and the
// settings summary from per-device applied position vs the vault head.
// Owner copy rule: plain, concise, no hyphens or dashes of any kind.

export type DeviceSyncStatus = "never" | "behind" | "uptodate";

// appliedSeq null = never reported; 0 is a real position (synced an empty vault).
export function deviceSyncStatus(appliedSeq: number | null, headSeq: number): DeviceSyncStatus {
  if (appliedSeq === null) return "never";
  if (appliedSeq >= headSeq) return "uptodate";
  return "behind";
}

export function deviceStatusText(appliedSeq: number | null, headSeq: number): string {
  if (appliedSeq === null) return "Never synced";
  if (appliedSeq >= headSeq) return "Up to date";
  const behind = headSeq - appliedSeq;
  return `${behind} change${behind === 1 ? "" : "s"} behind`;
}

// A never-synced device has no meaningful last-seen; show just "Never synced".
export function deviceDescText(
  device: { lastSeenAt: number; appliedSeq: number | null; headSeq: number },
  relativeTime: (epochSeconds: number) => string,
): string {
  if (deviceSyncStatus(device.appliedSeq, device.headSeq) === "never") return "Never synced";
  return `Last seen ${relativeTime(device.lastSeenAt)} · ${
    deviceStatusText(device.appliedSeq, device.headSeq)
  }`;
}

// #526: settings help row: the admin token is rotated server-side (no button).
export const ROTATE_ADMIN_TOKEN_NAME = "Rotate admin token";
export const ROTATE_ADMIN_TOKEN_DESC =
  "Run the rotate admin token script in the deploy folder on your server.";

// Settings summary row: behind counts only devices that ARE behind (a
// never-synced device isn't behind, even with a higher vault head).
export function devicesSummaryText(
  devices: Array<{ appliedSeq: number | null; headSeq: number }>,
): string {
  const behind =
    devices.filter((d) => deviceSyncStatus(d.appliedSeq, d.headSeq) === "behind").length;
  return `${devices.length} device${devices.length === 1 ? "" : "s"} · ${behind} behind`;
}
