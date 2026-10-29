import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS, isSyncable } from "../../../plugin/plumbing/settings-types.ts";

const syncObsidianTrue = { ...DEFAULT_SETTINGS, syncObsidianConfig: true };
const syncObsidianFalse = { ...DEFAULT_SETTINGS, syncObsidianConfig: false };

// Default Obsidian config dir.
const syncable = (p: string, s: PluginSettings) => isSyncable(p, ".obsidian", s);

Deno.test("isSyncable - geode data dir hard-denylisted (syncObsidianConfig: true)", () => {
  assertEquals(syncable(".obsidian/plugins/geode/local-files.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/plugins/geode/sync-cursor.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/plugins/geode/data.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/plugins/geode/.geode_key_cache.json", syncObsidianTrue), false);
});

Deno.test("isSyncable - geode data dir hard-denylisted (syncObsidianConfig: false)", () => {
  assertEquals(syncable(".obsidian/plugins/geode/local-files.json", syncObsidianFalse), false);
  assertEquals(syncable(".obsidian/plugins/geode/data.json", syncObsidianFalse), false);
  assertEquals(syncable(".obsidian/plugins/geode/.geode_key_cache.json", syncObsidianFalse), false);
});

Deno.test("isSyncable - regression: normal notes are syncable", () => {
  assertEquals(syncable("notes/x.md", syncObsidianTrue), true);
  assertEquals(syncable("notes/x.md", syncObsidianFalse), true);
});

Deno.test("isSyncable - conflict files sync like normal files (#432 restored)", () => {
  // The losing edit stays backed up on the server and every device sees the
  // conflict, so a conflict file is not filtered out.
  assertEquals(syncable("notes (conflict Laptop 2026-10-12 1402).md", syncObsidianTrue), true);
  assertEquals(syncable("notes.conflict-2026-10-14T14-05-00.md", syncObsidianTrue), true);
});

Deno.test("isSyncable - plugin gating: opted-in plugin syncs", () => {
  const settings = { ...DEFAULT_SETTINGS, syncObsidianConfig: true, syncedPlugins: ["dataview"] };
  assertEquals(syncable(".obsidian/plugins/dataview/data.json", settings), true);
  assertEquals(syncable(".obsidian/plugins/dataview/cache/x.json", settings), true);
});

Deno.test("isSyncable - plugin gating: empty syncedPlugins blocks all plugins", () => {
  assertEquals(syncable(".obsidian/plugins/dataview/data.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/plugins/dataview/data.json", syncObsidianFalse), false);
});

Deno.test("isSyncable - plugin gating: geode always excluded even when opted-in", () => {
  const settings = { ...DEFAULT_SETTINGS, syncObsidianConfig: true, syncedPlugins: ["geode"] };
  assertEquals(syncable(".obsidian/plugins/geode/local-files.json", settings), false);
});

Deno.test("isSyncable - plugin gating: master toggle off wins", () => {
  const settings = { ...DEFAULT_SETTINGS, syncObsidianConfig: false, syncedPlugins: ["dataview"] };
  assertEquals(syncable(".obsidian/plugins/dataview/data.json", settings), false);
});

Deno.test("isSyncable - non-plugin config unchanged by plugin gating", () => {
  assertEquals(syncable(".obsidian/themes/Foo/theme.css", syncObsidianTrue), true);
  assertEquals(syncable(".obsidian/app.json", syncObsidianTrue), true);
  assertEquals(syncable(".obsidian/workspace.json", syncObsidianTrue), false);
});

Deno.test("isSyncable - regression: workspace.json always excluded", () => {
  assertEquals(syncable(".obsidian/workspace.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/workspace.json", syncObsidianFalse), false);
});

Deno.test("isSyncable - regression: graph.json always excluded", () => {
  assertEquals(syncable(".obsidian/graph.json", syncObsidianTrue), false);
  assertEquals(syncable(".obsidian/graph.json", syncObsidianFalse), false);
});

// #369: Obsidian's config dir is configurable (vault.configDir). isSyncable must
// honor it so a custom config dir's Geode data dir is excluded, not synced.

Deno.test("isSyncable - custom configDir: geode data dir excluded", () => {
  const cfg = ".config/obsidian";
  assertEquals(isSyncable(`${cfg}/plugins/geode/local-files.json`, cfg, syncObsidianTrue), false);
  assertEquals(isSyncable(`${cfg}/plugins/geode/sync-cursor.json`, cfg, syncObsidianTrue), false);
  assertEquals(isSyncable(`${cfg}/plugins/geode/data.json`, cfg, syncObsidianFalse), false);
  assertEquals(
    isSyncable(`${cfg}/plugins/geode/.geode_key_cache.json`, cfg, syncObsidianFalse),
    false,
  );
});

Deno.test("isSyncable - custom configDir: config files sync per toggle", () => {
  const cfg = ".config/obsidian";
  assertEquals(isSyncable(`${cfg}/app.json`, cfg, syncObsidianTrue), true);
  assertEquals(isSyncable(`${cfg}/themes/Foo/theme.css`, cfg, syncObsidianTrue), true);
  assertEquals(isSyncable(`${cfg}/app.json`, cfg, syncObsidianFalse), false);
});

Deno.test("isSyncable - custom configDir: excluded files + plugin gating still apply", () => {
  const cfg = ".config/obsidian";
  assertEquals(isSyncable(`${cfg}/workspace.json`, cfg, syncObsidianTrue), false);
  assertEquals(isSyncable(`${cfg}/graph.json`, cfg, syncObsidianTrue), false);
  const settings = { ...DEFAULT_SETTINGS, syncObsidianConfig: true, syncedPlugins: ["dataview"] };
  assertEquals(isSyncable(`${cfg}/plugins/dataview/data.json`, cfg, settings), true);
  assertEquals(isSyncable(`${cfg}/plugins/other/data.json`, cfg, settings), false);
});

Deno.test("isSyncable - configDir without trailing slash and with trailing slash agree", () => {
  const settings = { ...DEFAULT_SETTINGS, syncObsidianConfig: true };
  assertEquals(isSyncable(".config/obsidian/app.json", ".config/obsidian", settings), true);
  assertEquals(isSyncable(".config/obsidian/app.json", ".config/obsidian/", settings), true);
});
