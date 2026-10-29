/** Pure status-menu item resolution: no obsidian import (safe for deno unit tests). */

export type StatusMenuItemId =
  | "missing"
  | "pause"
  | "activity"
  | "conflicts"
  | "deleted"
  | "devices"
  | "settings";

export type StatusMenuItem = {
  id: StatusMenuItemId;
  /** Which pause action to run; only the pause item carries one. */
  action?: "pause" | "resume";
  label: string;
  icon: string;
  separatorBefore?: boolean;
};

export type StatusMenuInput = {
  unlocked: boolean;
  configured: boolean;
  paused: boolean;
  /** #432: the entry is the badge: "Conflicts (N)" while open, plain "Conflicts" at zero. */
  conflictCount: number;
  /** #601: files held by the mass-delete guard (0 = no hold). */
  heldCount: number;
};

/** The status icon menu (#430): mockup order, pause hidden while locked or not set up (#441). */
export function buildStatusMenu(input: StatusMenuInput): StatusMenuItem[] {
  const items: StatusMenuItem[] = [];
  // #601: while sync is on hold the review is the first entry: it is the only action
  // that lets sync move again.
  if (input.unlocked && input.heldCount > 0) {
    items.push({ id: "missing", label: "Review missing files", icon: "file-search" });
  }
  if (input.unlocked && input.configured) {
    items.push({
      id: "pause",
      action: input.paused ? "resume" : "pause",
      label: input.paused ? "Resume" : "Pause",
      icon: input.paused ? "play" : "pause",
    });
  }
  // #431: mockup order: after Pause/Resume, before Deleted files; visible while locked too.
  items.push({ id: "activity", label: "Sync activity", icon: "activity" });
  // #432: the entry is the badge, same git-merge glyph as the status icon.
  items.push({
    id: "conflicts",
    label: input.conflictCount > 0 ? `Conflicts (${input.conflictCount})` : "Conflicts",
    icon: "git-merge",
  });
  if (input.configured) {
    items.push({ id: "deleted", label: "Deleted files", icon: "trash-2" });
    items.push({ id: "devices", label: "Devices", icon: "laptop" });
  }
  items.push({
    id: "settings",
    label: "Geode settings",
    icon: "settings",
    separatorBefore: true,
  });
  return items;
}
