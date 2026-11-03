import { assertEquals } from "@std/assert";
import {
  definitionsOf,
  type TreeSection,
  wholeAtLeastOne,
} from "../../../plugin/ui/settings-tree.ts";

// #16: the Obsidian 1.13+ layout ("Mix"): lead blocks without a heading, headed groups,
// then the rarely used sections as sub-pages in one headless group at the end.

const row = (name: string) => ({ name });
const shown = () => true;

const sections: TreeSection<{ name: string }>[] = [
  { id: "banner", heading: "", kind: "lead", rows: [row("Sync paused")], visible: shown },
  { id: "status", heading: "Status", kind: "lead", rows: [row("Sync status")] },
  { id: "vault", heading: "Vault", kind: "group", rows: [row("Geode vault")] },
  { id: "advanced", heading: "Advanced", kind: "page", rows: [row("Server address")] },
  { id: "logs", heading: "Logs", kind: "page", rows: [row("Copy logs")], visible: shown },
];

Deno.test("settings-tree - lead sections are headless groups, groups keep their heading", () => {
  const [banner, status, vault] = definitionsOf(sections);
  assertEquals(banner, { type: "group", items: [row("Sync paused")], visible: shown });
  assertEquals(status, { type: "group", items: [row("Sync status")], visible: undefined });
  assertEquals(vault, {
    type: "group",
    heading: "Vault",
    items: [row("Geode vault")],
    visible: undefined,
  });
});

Deno.test("settings-tree - pages gather into one headless group after the groups", () => {
  const items = definitionsOf(sections);
  assertEquals(items.length, 4);
  assertEquals(items[3], {
    type: "group",
    items: [
      { type: "page", name: "Advanced", items: [row("Server address")], visible: undefined },
      { type: "page", name: "Logs", items: [row("Copy logs")], visible: shown },
    ],
  });
});

Deno.test("settings-tree - no pages, no trailing group", () => {
  const items = definitionsOf(sections.filter((s) => s.kind !== "page"));
  assertEquals(items.map((i) => i.type), ["group", "group", "group"]);
});

Deno.test("settings-tree - wholeAtLeastOne accepts whole numbers from 1", () => {
  assertEquals(wholeAtLeastOne(1), undefined);
  assertEquals(wholeAtLeastOne(48), undefined);
  for (const bad of [0, -3, 1.5, NaN]) assertEquals(typeof wholeAtLeastOne(bad), "string");
});
