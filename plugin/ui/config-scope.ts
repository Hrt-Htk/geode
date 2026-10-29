import type { ConfigCategory } from "../plumbing/settings-types.ts";

// #454: config-category UI strings + the row summary. Pure (obsidian-free) so
// the modal and the settings row share one copy and unit tests can drive it.
// Copy rule: plain, concise, no dashes.

export const CONFIG_CATEGORIES: Array<{ key: ConfigCategory; name: string }> = [
  { key: "appearance", name: "Appearance & themes" },
  { key: "snippets", name: "CSS snippets" },
  { key: "hotkeys", name: "Hotkeys" },
  { key: "corePlugins", name: "Core plugin settings" },
  { key: "other", name: "Other settings" },
];

export function toggleCategory(
  categories: ConfigCategory[],
  key: ConfigCategory,
  on: boolean,
): ConfigCategory[] {
  const next = [...categories];
  const idx = next.indexOf(key);
  if (on) {
    if (idx === -1) next.push(key);
  } else if (idx !== -1) {
    next.splice(idx, 1);
  }
  return next;
}

/** One-line summary for the "Config to sync" row. All on (the default) reads
 * like the mockup; a category off reads "All settings except <off list>". */
export function configSummary(
  categories: ConfigCategory[],
  pluginCount: number,
  totalPlugins: number,
): string {
  const plugins = totalPlugins > 0 ? ` · ${pluginCount} of ${totalPlugins} plugins` : "";
  const off = CONFIG_CATEGORIES.filter((c) => !categories.includes(c.key));
  if (off.length === 0) return `Snippets, themes, hotkeys${plugins}`;
  if (off.length === CONFIG_CATEGORIES.length) return `No settings${plugins}`;
  return `All settings except ${off.map((c) => c.name).join(", ")}${plugins}`;
}
