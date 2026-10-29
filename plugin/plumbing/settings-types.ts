import { normalizePath } from "../../core/normalize.ts";
import {
  MASS_DELETE_MIN_FILES,
  MASS_DELETE_MIN_PERCENT,
  type MassDeleteHold,
} from "../sync/mass-delete-hold.ts";

export interface PluginSettings {
  serverUrl: string;
  vaultId: string;
  vaultName: string;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  salt: string;
  verifier: string;
  argon2Params: { ops: number; mem: number };
  unlockTimeoutHours: number;
  syncObsidianConfig: boolean;
  syncedPlugins: string[];
  /** #454: config categories synced (list of ON categories). Every category
   * on by default, so existing users see no change; the folder toggle still
   * gates the whole config dir. */
  configCategories: ConfigCategory[];
  /** #342: vault folders excluded from sync, normalized with a trailing slash ("Projects/").
   * Exclusion model: everything syncs except these subtrees, with includedFolders as
   * switched on exceptions inside them. Deepest covering entry wins; both lists stay
   * minimal (toggling drops every entry underneath). */
  excludedFolders: string[];
  includedFolders: string[];
  /** #342: folders switched back on whose server-head catch-up hasn't completed
   * yet; persisted per-device (data.json), retried on reconnect, cleared on
   * success. #454: also holds config-category path prefixes on re-enable (the
   * same catch-up machinery). While pending, the reconciler treats the paths as
   * out of scope, so a local delete made while they were excluded can never
   * propagate. */
  pendingCatchUpFolders: string[];
  /** #342/#584: files renamed into an excluded folder (in→out), keyed to the
   * destination folder; when that folder is re-included the move completes instead of
   * duplicating. `destPath` (#584) is the name the file was parked under, so the move
   * closes with a rename marker naming it and the destination opens with its note. */
  pendingMoveOuts: Array<{ oldPath: string; destFolder: string; destPath?: string }>;
  debugLogging: boolean;
  trashRetentionDays: number;
  /** ms timestamp of the last pause; 0 = not paused. Persisted in data.json, written only on pause/resume. */
  pauseAt: number;
  /** #601: a held mass delete on this device (the tracked paths missing from disk and
   * when they were noticed); null = no hold. Persisted like `pauseAt`, so a restart stays
   * offline until `SyncManager.resolveMassDeleteHold` decides it. */
  massDeleteHold: MassDeleteHold | null;
  /** #701: a rejoin started and did not finish: the next session start must finish it
   * instead of replaying the rows it left armed. Cleared by a completed rejoin. */
  rejoinIncomplete: boolean;
  /** #601: the guard: hold only when BOTH this many files and this percent are gone. */
  massDeleteMinFiles: number;
  massDeleteMinPercent: number;
}

// #454: config-category keys (the mockup ConfigModal's settings categories).
// Listed before DEFAULT_SETTINGS, which seeds every category on.
export type ConfigCategory = "appearance" | "snippets" | "hotkeys" | "corePlugins" | "other";

export const ALL_CONFIG_CATEGORIES: ConfigCategory[] = [
  "appearance",
  "snippets",
  "hotkeys",
  "corePlugins",
  "other",
];

// New vaults derive at the Standard level (#457). DEFAULT_SETTINGS keeps the old
// value: it only fills a missing field on load, and existing vaults keep their own.
export const NEW_VAULT_ARGON2_PARAMS = { ops: 3, mem: 256 * 1024 * 1024 };

export const DEFAULT_SETTINGS: PluginSettings = {
  serverUrl: "",
  vaultId: "",
  vaultName: "",
  deviceId: "",
  deviceName: "",
  deviceToken: "",
  salt: "",
  verifier: "",
  argon2Params: { ops: 3, mem: 67108864 },
  unlockTimeoutHours: 24,
  syncObsidianConfig: false,
  syncedPlugins: [],
  configCategories: [...ALL_CONFIG_CATEGORIES],
  excludedFolders: [],
  includedFolders: [],
  pendingCatchUpFolders: [],
  pendingMoveOuts: [],
  debugLogging: false,
  trashRetentionDays: 30,
  pauseAt: 0,
  massDeleteHold: null,
  rejoinIncomplete: false,
  massDeleteMinFiles: MASS_DELETE_MIN_FILES,
  massDeleteMinPercent: MASS_DELETE_MIN_PERCENT,
};

const GEODE_PLUGIN_ID = "geode";

// Obsidian's config dir is configurable (vault.configDir); the Geode data dir
// lives under it as <configDir>/plugins/geode. isSyncable derives both from the
// caller-provided configDir instead of hard-coding ".obsidian" (#369).
export function isConfigured(settings: PluginSettings): boolean {
  return !!(settings.serverUrl && settings.vaultId && settings.deviceToken);
}

// ── #454: per-category config sync scope ───────────────────────────────────
// The single category→path mapping. Categories (from the mockup ConfigModal):
//   appearance  = appearance.json + themes/
//   snippets    = snippets/
//   hotkeys     = hotkeys.json
//   corePlugins = core-plugins.json + core-plugins-migration.json + the core
//                 plugins' own root config files (<id>.json)
//   other       = every remaining root file (app.json, unknown root files)
// Community plugins are governed per-plugin by syncedPlugins (plugins/<id>/)
// and by community-plugins.json, which is not a settings category.
// Workspace/cache files never sync. Geode's own plugin dir never syncs.

/** Files in the config dir that never sync, regardless of category toggles:
 * workspace/cache files, plus graph.json: a core plugin config, but excluded
 * since the pre-#454 list and asserted never-synced by the bench + is-syncable
 * regression tests. Kept for existing users to see no change (#454). */
const NEVER_SYNC_CONFIG_FILES = new Set([
  "workspace.json",
  "workspace-mobile.json",
  "graph.json",
]);

/** Obsidian core plugin config filenames (id → <id>.json at the config root),
 * verified against the installed Obsidian app's internal plugin ids (Oct 2026).
 * An enabled core plugin writes its settings here; unknown root files fall to
 * Other settings. graph.json is a core plugin config but is excluded via
 * NEVER_SYNC_CONFIG_FILES (kept from the pre-#454 list). */
const CORE_PLUGIN_CONFIG_FILES = new Set([
  "audio-recorder",
  "backlink",
  "bases",
  "bookmarks",
  "canvas",
  "command-palette",
  "daily-notes",
  "editor-status",
  "file-explorer",
  "file-recovery",
  "footnotes",
  "global-search",
  "graph",
  "markdown-importer",
  "note-composer",
  "outgoing-link",
  "outline",
  "page-preview",
  "properties",
  "publish",
  "random-note",
  "search",
  "slash-command",
  "slides",
  "starred",
  "switcher",
  "sync",
  "tag-pane",
  "templates",
  "types",
  "webviewer",
  "word-count",
  "workspaces",
  "zk-prefixer",
]);

export type ConfigScope = ConfigCategory | "communityPlugins" | "never";

/** #454: classify a config path's position relative to the config dir (the
 * prefix already stripped). The single category→path mapping, shared by
 * configScopeForPath and isSyncable so neither re-normalizes. */
function classifyConfigRel(rel: string): ConfigScope {
  const segs = rel.split("/");
  const name = segs[segs.length - 1];
  if (NEVER_SYNC_CONFIG_FILES.has(name)) return "never";
  if (segs[0] === "themes") return "appearance";
  if (segs[0] === "snippets") return "snippets";
  if (segs[0] === "plugins") return "communityPlugins";
  if (name === "community-plugins.json") return "communityPlugins";
  if (name === "appearance.json") return "appearance";
  if (name === "hotkeys.json") return "hotkeys";
  if (name === "core-plugins.json" || name === "core-plugins-migration.json") {
    return "corePlugins";
  }
  if (name === "app.json") return "other";
  if (CORE_PLUGIN_CONFIG_FILES.has(name.replace(/\.json$/, ""))) return "corePlugins";
  return "other";
}

export function configScopeForPath(path: string, configDir: string): ConfigScope {
  const norm = normalizePath(path);
  const cfg = normalizePath(configDir).replace(/\/+$/, "");
  if (!norm.startsWith(cfg + "/")) return "never";
  return classifyConfigRel(norm.slice(cfg.length + 1));
}

/** #454: the pendingCatchUpFolders entry for the `other` category. `other` is
 * an open set (every remaining config-root file), so it can't be a finite
 * prefix list; this single sentinel stands for "every config path that
 * classifies as other" and is matched by the classifier, not by path. It does
 * not end in "/" so it can't collide with a folder-scope prefix. */
export function otherCatchUpEntry(configDir: string): string {
  return normalizePath(configDir).replace(/\/+$/, "") + "/__geode_other__";
}

/** #454: the path prefixes whose server heads a re-enabled category catches up
 * to (reuses #342's folder catch-up: prefixes go into pendingCatchUpFolders and
 * through SyncManager.catchUpFolders). Files are exact paths, dirs carry a
 * trailing slash. `other` is an open set, so it is the single classifier-matched
 * sentinel (otherCatchUpEntry) covering every remaining config-root file. */
export function configCategoryScopePrefixes(category: ConfigCategory, configDir: string): string[] {
  const cfg = normalizePath(configDir).replace(/\/+$/, "");
  switch (category) {
    case "appearance":
      return [`${cfg}/appearance.json`, `${cfg}/themes/`];
    case "snippets":
      return [`${cfg}/snippets/`];
    case "hotkeys":
      return [`${cfg}/hotkeys.json`];
    case "corePlugins": {
      const files = [
        "core-plugins.json",
        "core-plugins-migration.json",
        ...[...CORE_PLUGIN_CONFIG_FILES].map((id) => `${id}.json`),
      ];
      return files.map((f) => `${cfg}/${f}`);
    }
    case "other":
      return [otherCatchUpEntry(cfg)];
  }
}

// #342: the single folder-scope decision. Entries are normalized vault folder
// prefixes with a trailing slash; the DEEPEST covering entry wins, and a path
// with no covering entry syncs (exclusion model). Case is significant (Obsidian
// paths are case-sensitive).
export function isPathInScope(
  path: string,
  excludedFolders: string[],
  includedFolders: string[],
): boolean {
  const norm = normalizePath(path);
  let bestKind: "excluded" | "included" | null = null;
  let bestLen = -1;
  for (const e of excludedFolders) {
    if ((norm === e || norm.startsWith(e)) && e.length > bestLen) {
      bestKind = "excluded";
      bestLen = e.length;
    }
  }
  for (const i of includedFolders) {
    if ((norm === i || norm.startsWith(i)) && i.length > bestLen) {
      bestKind = "included";
      bestLen = i.length;
    }
  }
  return bestKind !== "excluded";
}

/** #701: where a rejoin over an old copy sets aside the bytes the server cannot
 * vouch for. A visible vault folder, and never synced on any device: it holds what the
 * server is about to overwrite, so uploading it would re-create the very notes the
 * rejoin just cleared. */
export const REJOIN_BACKUP_FOLDER = "Geode backup";

export function isRejoinBackupPath(path: string): boolean {
  const norm = normalizePath(path);
  return norm === REJOIN_BACKUP_FOLDER || norm.startsWith(`${REJOIN_BACKUP_FOLDER}/`);
}

// Precedence: the rejoin backup folder and folder scope win over everything, then the
// config rules apply inside the config dir, then everything else syncs.
export function isSyncable(path: string, configDir: string, settings: PluginSettings): boolean {
  const norm = normalizePath(path);
  // #701: the backup folder is out of scope on every device, whatever the folder scope
  // says, so it can never become a create.
  if (isRejoinBackupPath(norm)) return false;
  // #342: folder scope wins over everything else.
  if (!isPathInScope(norm, settings.excludedFolders, settings.includedFolders)) return false;
  const cfg = normalizePath(configDir).replace(/\/+$/, "");
  if (norm.startsWith(cfg + "/")) {
    if (norm.startsWith(`${cfg}/plugins/${GEODE_PLUGIN_ID}/`)) return false;
    if (!settings.syncObsidianConfig) return false;
    if (norm.startsWith(`${cfg}/plugins/`)) {
      const rest = norm.slice(cfg.length + 1); // "plugins/<id>/..."
      const pluginId = rest.split("/")[1];
      if (pluginId && !settings.syncedPlugins.includes(pluginId)) return false;
      return true;
    }
    // #454: per-category scope. workspace/cache files never sync;
    // community-plugins.json is governed by the folder toggle alone.
    const scope = classifyConfigRel(norm.slice(cfg.length + 1));
    if (scope === "never") return false;
    if (scope === "communityPlugins") return true;
    return settings.configCategories.includes(scope);
  }
  return !norm.startsWith("/");
}

/** The vault identity fields a create or a join rewrites. */
export type VaultIdentity = Pick<
  PluginSettings,
  | "serverUrl"
  | "vaultId"
  | "vaultName"
  | "deviceId"
  | "deviceName"
  | "deviceToken"
  | "salt"
  | "verifier"
  | "argon2Params"
>;

/** Write a new vault identity (a create or a join). #701: an incomplete rejoin marker
 * belongs to the vault it was set on, so a new identity drops it: the next session must
 * never rebuild this folder as a rejoin of another vault (it would copy the folder out and
 * prune it). Dropping a marker also lifts the pause that marker left: joining again is the
 * user asking to sync this vault, and the rebuild cannot lift it once the marker is gone. */
export function withVaultIdentity(
  settings: PluginSettings,
  identity: Partial<VaultIdentity>,
): PluginSettings {
  return {
    ...settings,
    ...identity,
    rejoinIncomplete: false,
    pauseAt: settings.rejoinIncomplete ? 0 : settings.pauseAt,
  };
}

/** Return a new settings object with vault identity fields cleared (for "leave vault").
 * Preserves all non-identity prefs (unlockTimeoutHours, syncedPlugins, etc.).
 * Does NOT mutate the input object. */
export function clearedVaultSettings(s: PluginSettings): PluginSettings {
  return {
    ...s,
    serverUrl: "",
    vaultId: "",
    vaultName: "",
    deviceId: "",
    deviceName: "",
    deviceToken: "",
    salt: "",
    verifier: "",
    argon2Params: { ...DEFAULT_SETTINGS.argon2Params },
    pauseAt: 0,
    massDeleteHold: null,
    rejoinIncomplete: false,
  };
}
