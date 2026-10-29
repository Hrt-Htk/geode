import { assertEquals } from "@std/assert";
import {
  allVisibleSelected,
  pruneSelected,
  selectedPurgeLabel,
  selectionCountLabel,
  toggleAllSelected,
  visibleEntries,
} from "../../../plugin/ui/trash-select.ts";

// #446 sign-off: bulk select: selection is keyed by path and survives search
// filtering; Select all toggles the visible (filtered) rows only.

type Row = { path: string };
const ROWS: Row[] = [
  { path: "Daily/2026-10-01.md" },
  { path: "Attachments/diagram.svg" },
  { path: "Projects/Old plan.md" },
];

Deno.test("visibleEntries - empty query shows all, case-insensitive path filter", () => {
  assertEquals(visibleEntries(ROWS, ""), ROWS);
  assertEquals(visibleEntries(ROWS, "  "), ROWS);
  assertEquals(visibleEntries(ROWS, "daily"), [ROWS[0]]);
  assertEquals(visibleEntries(ROWS, "ATTACH"), [ROWS[1]]);
  assertEquals(visibleEntries(ROWS, "zzz"), []);
});

Deno.test("visibleEntries - trims and lowercases the query", () => {
  assertEquals(visibleEntries(ROWS, "  Old Plan  "), [ROWS[2]]);
});

Deno.test("pruneSelected - drops paths that left the trash list, keeps the rest", () => {
  const selected = new Set(["Daily/2026-10-01.md", "gone.md", "Projects/Old plan.md"]);
  const pruned = pruneSelected(selected, ROWS);
  assertEquals([...pruned].sort(), ["Daily/2026-10-01.md", "Projects/Old plan.md"]);
});

Deno.test("toggleAllSelected - selects all visible, then deselects them", () => {
  const selected = new Set<string>();
  const checked = toggleAllSelected(selected, [ROWS[0], ROWS[1]], true);
  assertEquals([...checked].sort(), ["Attachments/diagram.svg", "Daily/2026-10-01.md"]);
  const unchecked = toggleAllSelected(checked, [ROWS[0], ROWS[1]], false);
  assertEquals([...unchecked], []);
  // Rows hidden by the filter are untouched.
  const partial = new Set([ROWS[2].path]);
  assertEquals(
    [...toggleAllSelected(partial, [ROWS[0]], true)].sort(),
    ["Daily/2026-10-01.md", "Projects/Old plan.md"],
  );
});

Deno.test("allVisibleSelected - false when nothing visible or any visible row unselected", () => {
  assertEquals(allVisibleSelected(new Set(), []), false);
  assertEquals(allVisibleSelected(new Set([ROWS[0].path]), [ROWS[0], ROWS[1]]), false);
  assertEquals(
    allVisibleSelected(new Set([ROWS[0].path, ROWS[1].path]), [ROWS[0], ROWS[1]]),
    true,
  );
  // Selection includes rows hidden by the filter; still all-visible-selected.
  assertEquals(
    allVisibleSelected(new Set([ROWS[0].path, ROWS[1].path, ROWS[2].path]), [ROWS[0], ROWS[1]]),
    true,
  );
});

Deno.test("selectionCountLabel - singular and plural", () => {
  assertEquals(selectionCountLabel(1), "1 selected");
  assertEquals(selectionCountLabel(3), "3 selected");
});

Deno.test("selectedPurgeLabel - singular and plural", () => {
  assertEquals(selectedPurgeLabel(1), "Purge selected (1)");
  assertEquals(selectedPurgeLabel(4), "Purge selected (4)");
});
