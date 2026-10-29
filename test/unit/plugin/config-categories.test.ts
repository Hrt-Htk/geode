import { assert, assertEquals } from "@std/assert";
import {
  ALL_CONFIG_CATEGORIES,
  configCategoryScopePrefixes,
  configScopeForPath,
  DEFAULT_SETTINGS,
  isSyncable,
  otherCatchUpEntry,
  type PluginSettings,
} from "../../../plugin/plumbing/settings-types.ts";

// #454: per-category config sync scope. configScopeForPath decides a config
// path's category; isSyncable gates it on the settings toggle.

const cfg = ".obsidian";
const onAll = { ...DEFAULT_SETTINGS, syncObsidianConfig: true }; // categories default all on

const scope = (p: string) => configScopeForPath(p, cfg);

Deno.test("configScope - appearance: appearance.json and themes/", () => {
  assertEquals(scope(`${cfg}/appearance.json`), "appearance");
  assertEquals(scope(`${cfg}/themes/Things/manifest.json`), "appearance");
  assertEquals(scope(`${cfg}/themes/Things/theme.css`), "appearance");
});

Deno.test("configScope - snippets: snippets/", () => {
  assertEquals(scope(`${cfg}/snippets/custom.css`), "snippets");
});

Deno.test("configScope - hotkeys: hotkeys.json", () => {
  assertEquals(scope(`${cfg}/hotkeys.json`), "hotkeys");
});

Deno.test("configScope - corePlugins: core-plugins.json + core plugin config files", () => {
  assertEquals(scope(`${cfg}/core-plugins.json`), "corePlugins");
  assertEquals(scope(`${cfg}/core-plugins-migration.json`), "corePlugins");
  assertEquals(scope(`${cfg}/daily-notes.json`), "corePlugins");
  assertEquals(scope(`${cfg}/templates.json`), "corePlugins");
  assertEquals(scope(`${cfg}/types.json`), "corePlugins");
  assertEquals(scope(`${cfg}/bookmarks.json`), "corePlugins");
});

// graph.json is a core plugin config file but is excluded (never syncs), kept
// from the pre-#454 exclusion list; the bench and is-syncable regression tests
// assert it is never synced.
Deno.test("configScope - graph.json stays excluded (never syncs)", () => {
  assertEquals(scope(`${cfg}/graph.json`), "never");
  assertEquals(isSyncable(`${cfg}/graph.json`, cfg, onAll), false);
});

Deno.test("configScope - other: app.json and unknown root files", () => {
  assertEquals(scope(`${cfg}/app.json`), "other");
  assertEquals(scope(`${cfg}/todoist-token`), "other");
  assertEquals(scope(`${cfg}/unknown-plugin-file.json`), "other");
  assertEquals(scope(`${cfg}/somedir/file.json`), "other");
});

Deno.test("configScope - community-plugins.json is not a settings category", () => {
  assertEquals(scope(`${cfg}/community-plugins.json`), "communityPlugins");
});

Deno.test("configScope - workspace/cache files never sync", () => {
  assertEquals(scope(`${cfg}/workspace.json`), "never");
  assertEquals(scope(`${cfg}/workspace-mobile.json`), "never");
});

Deno.test("configScope - configDir is not hard coded (#369)", () => {
  const custom = ".config/obsidian";
  assertEquals(configScopeForPath(`${custom}/hotkeys.json`, custom), "hotkeys");
  assertEquals(configScopeForPath(`${custom}/themes/X/theme.css`, custom), "appearance");
  // Geode's own data dir is excluded via isSyncable, not the category classifier.
  assertEquals(isSyncable(`${custom}/plugins/geode/data.json`, custom, onAll), false);
});

Deno.test("isSyncable - a category off blocks its paths, leaves others", () => {
  const s: PluginSettings = {
    ...onAll,
    configCategories: ALL_CONFIG_CATEGORIES.filter((c) => c !== "hotkeys"),
  };
  assertEquals(isSyncable(`${cfg}/hotkeys.json`, cfg, s), false);
  assertEquals(isSyncable(`${cfg}/appearance.json`, cfg, s), true);
  assertEquals(isSyncable(`${cfg}/snippets/a.css`, cfg, s), true);
  assertEquals(isSyncable(`${cfg}/daily-notes.json`, cfg, s), true);
});

Deno.test("isSyncable - snippets off blocks snippets, keeps themes", () => {
  const s: PluginSettings = {
    ...onAll,
    configCategories: ALL_CONFIG_CATEGORIES.filter((c) => c !== "snippets"),
  };
  assertEquals(isSyncable(`${cfg}/snippets/a.css`, cfg, s), false);
  assertEquals(isSyncable(`${cfg}/themes/X/theme.css`, cfg, s), true);
});

Deno.test("isSyncable - all categories off blocks every config file", () => {
  const s: PluginSettings = { ...onAll, configCategories: [] };
  assertEquals(isSyncable(`${cfg}/app.json`, cfg, s), false);
  assertEquals(isSyncable(`${cfg}/hotkeys.json`, cfg, s), false);
  assertEquals(isSyncable(`${cfg}/themes/X/theme.css`, cfg, s), false);
});

Deno.test("isSyncable - community-plugins.json syncs with the folder toggle only", () => {
  assertEquals(
    isSyncable(`${cfg}/community-plugins.json`, cfg, { ...onAll, configCategories: [] }),
    true,
  );
  assertEquals(isSyncable(`${cfg}/community-plugins.json`, cfg, onAll), true);
});

Deno.test("isSyncable - workspace/cache files never sync even with all categories on", () => {
  assertEquals(isSyncable(`${cfg}/workspace.json`, cfg, onAll), false);
  assertEquals(isSyncable(`${cfg}/workspace-mobile.json`, cfg, onAll), false);
});

Deno.test("isSyncable - geode data dir never syncs even with all categories on", () => {
  assertEquals(isSyncable(`${cfg}/plugins/geode/data.json`, cfg, onAll), false);
});

Deno.test("configScope - plugin data dirs are not settings categories", () => {
  assertEquals(scope(`${cfg}/plugins/dataview/data.json`), "communityPlugins");
});

Deno.test("configCategoryScopePrefixes - each category has its path scope", () => {
  assertEquals(configCategoryScopePrefixes("appearance", cfg), [
    ".obsidian/appearance.json",
    ".obsidian/themes/",
  ]);
  assertEquals(configCategoryScopePrefixes("snippets", cfg), [".obsidian/snippets/"]);
  assertEquals(configCategoryScopePrefixes("hotkeys", cfg), [".obsidian/hotkeys.json"]);
  // `other` is an open set: the single classifier-matched sentinel, not app.json.
  assertEquals(configCategoryScopePrefixes("other", cfg), [otherCatchUpEntry(cfg)]);
  assert(
    !configCategoryScopePrefixes("other", cfg)[0].endsWith("/"),
    "sentinel is not a folder prefix",
  );

  // corePlugins: the two category files + every core plugin config file.
  const core = configCategoryScopePrefixes("corePlugins", cfg);
  assertEquals(core.slice(0, 4), [
    ".obsidian/core-plugins.json",
    ".obsidian/core-plugins-migration.json",
    ".obsidian/audio-recorder.json",
    ".obsidian/backlink.json",
  ]);
  assert(core.includes(".obsidian/daily-notes.json"));
  assert(core.includes(".obsidian/templates.json"));
  assert(core.includes(".obsidian/types.json"));
});
