import { assertEquals } from "@std/assert";
import {
  DEFAULT_SETTINGS,
  isPathInScope,
  isSyncable,
  type PluginSettings,
} from "../../../plugin/plumbing/settings-types.ts";

const base: PluginSettings = { ...DEFAULT_SETTINGS, syncObsidianConfig: true };

Deno.test("isPathInScope - file under excluded folder", () => {
  assertEquals(isPathInScope("Projects/Old/notes.md", ["Projects/"], []), false);
  assertEquals(isPathInScope("Projects/Geode/plan.md", ["Projects/Old/"], []), true);
  assertEquals(isPathInScope("notes.md", ["Projects/"], []), true);
  assertEquals(isPathInScope("anything.md", [], []), true);
});

Deno.test("isPathInScope - included exception and deepest entry", () => {
  assertEquals(isPathInScope("Projects/Geode/plan.md", ["Projects/"], ["Projects/Geode/"]), true);
  assertEquals(isPathInScope("Projects/top.md", ["Projects/"], ["Projects/Geode/"]), false);
  assertEquals(
    isPathInScope("Projects/Geode/sub/x.md", ["Projects/Geode/sub/"], ["Projects/Geode/"]),
    false,
  );
});

Deno.test("isPathInScope - normalization: backslashes, duplicate slashes, leading slash", () => {
  assertEquals(isPathInScope("Projects\\Old\\notes.md", ["Projects/"], []), false);
  assertEquals(isPathInScope("/Projects/Old/notes.md", ["Projects/"], []), false);
  assertEquals(isPathInScope("Projects//Old//notes.md", ["Projects/"], []), false);
});

Deno.test("isPathInScope - case is significant (Obsidian treats paths case-sensitively)", () => {
  assertEquals(isPathInScope("projects/old/notes.md", ["Projects/"], []), true);
});

Deno.test("isSyncable - excluded folder blocks files inside, leaves others", () => {
  const s = { ...base, excludedFolders: ["Projects/Old/"] };
  assertEquals(isSyncable("Projects/Old/notes.md", ".obsidian", s), false);
  assertEquals(isSyncable("Projects/Geode/plan.md", ".obsidian", s), true);
  assertEquals(isSyncable("notes.md", ".obsidian", s), true);
});

Deno.test("isSyncable - included exception under an excluded parent syncs", () => {
  const s = { ...base, excludedFolders: ["Projects/"], includedFolders: ["Projects/Geode/"] };
  assertEquals(isSyncable("Projects/Geode/plan.md", ".obsidian", s), true);
  assertEquals(isSyncable("Projects/Old/notes.md", ".obsidian", s), false);
  assertEquals(isSyncable("Projects/top.md", ".obsidian", s), false);
});

Deno.test("isSyncable - folder scope wins over the config toggle (precedence)", () => {
  const s = { ...base, excludedFolders: [".obsidian/"] };
  assertEquals(isSyncable(".obsidian/app.json", ".obsidian", s), false);
  assertEquals(isSyncable(".obsidian/plugins/dataview/data.json", ".obsidian", s), false);
  // Config rules still apply when the folder is in scope.
  const s2 = { ...base, excludedFolders: [] };
  assertEquals(isSyncable(".obsidian/workspace.json", ".obsidian", s2), false);
  assertEquals(isSyncable(".obsidian/app.json", ".obsidian", s2), true);
});

Deno.test("isSyncable - empty scope lists change nothing", () => {
  const s = { ...base, excludedFolders: [], includedFolders: [] };
  assertEquals(isSyncable("notes/foo.md", ".obsidian", s), true);
  assertEquals(isSyncable(".obsidian/workspace.json", ".obsidian", s), false);
});
