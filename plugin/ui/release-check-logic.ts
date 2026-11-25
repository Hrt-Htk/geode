/** #93: pure decisions for startup plugin update checks, notify-once, What's new tab-once,
 * and Plugin version row copy. No obsidian import (safe for deno unit tests). */
import { compareSemVer } from "../../core/version.ts";
import { isFinalVersion } from "../plumbing/release-client.ts";

export const GEODE_COMMUNITY_PLUGIN_URL = "obsidian://show-plugin?id=geode";

export const CHECK_FOR_UPDATES_DESC = "Ask GitHub for a new Geode version when Obsidian starts.";
export const WHATS_NEW_ROW_NAME = "What's new";
export const WHATS_NEW_ROW_DESC = "Release notes for this version.";
export const WHATS_NEW_OPEN_BUTTON = "Open";
export const PLUGIN_UPDATE_NOTICE_LINK = "Open in community plugins";

export type BundledReleaseNote = {
  version: string;
  body: string;
};

/** True when a newer version is available and has not been notified yet on this device. */
export function shouldNotifyForRelease(
  currentVersion: string,
  availableVersion: string | null,
  lastNotifiedReleaseVersion: string,
): availableVersion is string {
  if (!availableVersion) return false;
  if (compareSemVer(availableVersion, currentVersion) <= 0) return false;
  return lastNotifiedReleaseVersion !== availableVersion;
}

export type PluginVersionRowInput = {
  own: string;
  checkEnabled: boolean;
  checked: boolean;
  available: string | null;
};

export type PluginVersionRowState = {
  desc: string;
  showUpdate: boolean;
};

/** Status row for Plugin version: bare when check is off or unchecked; availability when on. */
export function pluginVersionRow(i: PluginVersionRowInput): PluginVersionRowState {
  if (!i.checkEnabled) return { desc: i.own, showUpdate: false };
  if (i.available && compareSemVer(i.available, i.own) > 0) {
    return { desc: `${i.own}. ${i.available} is available.`, showUpdate: true };
  }
  if (i.checked) return { desc: `${i.own}. Up to date.`, showUpdate: false };
  return { desc: i.own, showUpdate: false };
}

export type WhatsNewStartupAction =
  | { kind: "none" }
  | { kind: "record"; version: string }
  | { kind: "open"; version: string };

/** Decide whether startup opens What's new: once per device on an upgrade to a newer final
 * version, never on a fresh install (record silently), never on a downgrade, never for a beta. */
export function whatsNewStartupAction(
  currentVersion: string,
  lastSeenVersion: string,
): WhatsNewStartupAction {
  if (!lastSeenVersion) return { kind: "record", version: currentVersion };
  if (!isFinalVersion(currentVersion)) return { kind: "none" };
  if (compareSemVer(currentVersion, lastSeenVersion) <= 0) return { kind: "none" };
  return { kind: "open", version: currentVersion };
}

export type WhatsNewContent =
  | { kind: "empty" }
  | { kind: "release"; version: string; body: string }
  | { kind: "beta"; installedVersion: string; version: string; body: string };

/** Select the bundled release notes to render in the What's new tab (notes sorted newest-first). */
export function selectWhatsNewContent(
  installedVersion: string,
  notes: readonly BundledReleaseNote[],
): WhatsNewContent {
  if (notes.length === 0) return { kind: "empty" };
  if (!isFinalVersion(installedVersion)) {
    const latest = notes[0];
    return {
      kind: "beta",
      installedVersion,
      version: latest.version,
      body: latest.body,
    };
  }
  const match = notes.find((n) => n.version === installedVersion) ?? notes[0];
  return { kind: "release", version: match.version, body: match.body };
}
