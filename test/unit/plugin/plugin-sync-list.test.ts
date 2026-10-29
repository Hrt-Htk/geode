import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { computePluginRows, togglePlugin } from "../../../plugin/ui/plugin-sync-list.ts";

// --- computePluginRows ---

Deno.test("computePluginRows - empty manifests returns empty array", () => {
  assertEquals(computePluginRows({}, [], "geode"), []);
});

Deno.test("computePluginRows - excludes self (geode) id", () => {
  const manifests = {
    geode: { id: "geode", name: "Geode" },
    dataview: { id: "dataview", name: "Dataview" },
  };
  const rows = computePluginRows(manifests, [], "geode");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, "dataview");
});

Deno.test("computePluginRows - sets checked from syncedPlugins", () => {
  const manifests = {
    dataview: { id: "dataview", name: "Dataview" },
    templater: { id: "templater", name: "Templater" },
  };
  const rows = computePluginRows(manifests, ["dataview"], "geode");
  assertEquals(rows.find((r) => r.id === "dataview")?.checked, true);
  assertEquals(rows.find((r) => r.id === "templater")?.checked, false);
});

Deno.test("computePluginRows - sorted by name case-insensitive", () => {
  const manifests = {
    zebra: { id: "zebra", name: "Zebra" },
    alpha: { id: "alpha", name: "alpha" },
    Beta: { id: "beta", name: "Beta" },
  };
  const rows = computePluginRows(manifests, [], "geode");
  assertEquals(rows.map((r) => r.id), ["alpha", "beta", "zebra"]);
});

// --- togglePlugin ---

Deno.test("togglePlugin - adds when on", () => {
  const input: string[] = [];
  const result = togglePlugin(input, "dataview", true);
  assertEquals(result, ["dataview"]);
  assertEquals(input, []); // original not mutated
});

Deno.test("togglePlugin - removes when off", () => {
  const input = ["dataview", "templater"];
  const result = togglePlugin(input, "dataview", false);
  assertEquals(result, ["templater"]);
  assertEquals(input, ["dataview", "templater"]); // original not mutated
});

Deno.test("togglePlugin - dedupes when adding already-present id", () => {
  const input = ["dataview"];
  const result = togglePlugin(input, "dataview", true);
  assertEquals(result, ["dataview"]);
  assertEquals(result.length, 1);
});

Deno.test("togglePlugin - returns a new array", () => {
  const input = ["dataview"];
  const result = togglePlugin(input, "templater", true);
  assertNotStrictEquals(result, input);
});
