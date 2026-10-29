import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS, isSyncable } from "../../../plugin/plumbing/settings-types.ts";

const syncObsidianTrue = { ...DEFAULT_SETTINGS, syncObsidianConfig: true };

Deno.test("isSyncable - workspace-mobile.json excluded (issue #200)", () => {
  assertEquals(isSyncable(".obsidian/workspace-mobile.json", ".obsidian", syncObsidianTrue), false);
});

Deno.test("isSyncable - positive controls", () => {
  assertEquals(isSyncable(".obsidian/workspace.json", ".obsidian", syncObsidianTrue), false);
  assertEquals(isSyncable(".obsidian/app.json", ".obsidian", syncObsidianTrue), true);
  assertEquals(isSyncable("notes/foo.md", ".obsidian", syncObsidianTrue), true);
});
