/** #625/#51: UI copy for a version-blocked session, obsidian-free (safe for deno unit tests). */
import type { BlockedSide } from "../sync/version-state.ts";

export interface BlockedCopy {
  title: string;
  notice: string;
  bannerDesc: string;
  tooltip: string;
  row: string;
}

const BLOCKED_COPY: Record<BlockedSide, BlockedCopy> = {
  plugin: {
    title: "Update required",
    notice: "Geode needs an update to keep syncing. Update the plugin, then reload Obsidian.",
    bannerDesc: "Update the plugin, then reload Obsidian.",
    tooltip: "Geode: update the plugin to keep syncing",
    row: "Update the plugin to keep syncing.",
  },
  server: {
    title: "Sync is stopped",
    notice: "Sync is stopped. The server is too old for this plugin. Update it to sync again.",
    bannerDesc: "The server is too old for this plugin. Update it to sync again.",
    tooltip: "Geode: sync is stopped. Update the server to sync again.",
    row: "Sync is stopped. Update the server to sync again.",
  },
};

/** Blocked UI copy: names the side that has to update. */
export function blockedCopy(side: BlockedSide): BlockedCopy {
  return BLOCKED_COPY[side];
}
