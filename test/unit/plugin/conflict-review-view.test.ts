import { assertEquals } from "@std/assert";
import type { ConflictRow } from "../../../plugin/sync/conflict-list.ts";
import { planResolution } from "../../../plugin/sync/conflict-resolve.ts";
import {
  BACK_BUTTON,
  comparedLines,
  CONFLICT_GONE,
  dateStamp,
  fileName,
  folderLine,
  KEEP_BOTH_BUTTON,
  KEEP_CONFLICT_BUTTON,
  KEEP_ORIGINAL_BUTTON,
  keepActions,
  NO_DATE,
  OPEN_BOTH_LINK,
  READ_FAILED,
  REVIEW_BUTTON,
  reviewKeys,
  reviewTitle,
} from "../../../plugin/ui/conflict-review-view.ts";

// #435: the Conflicts review screen's view model is obsidian-free: the row's
// two lines, the Original / Conflict key with a date and a time, which keep
// action each button maps to on either device, and the source tagged comparison.

const PATH = "Notes/Plan.md";
const CONFLICT_PATH = "Notes/Plan (conflict Laptop B 2026-10-21 1405).md";

// The creating device: the conflict file holds this device's own edit.
const CREATING: ConflictRow = {
  path: PATH,
  conflictPath: CONFLICT_PATH,
  type: "note",
  conflictFileIsMine: true,
  mine: { device: "Laptop B", time: new Date(2026, 9, 21, 14, 7).getTime(), size: 40 },
  theirs: { device: "Laptop A", time: new Date(2026, 9, 21, 14, 5).getTime(), size: 38 },
};

// The receiving device: the conflict file arrived from another device.
const RECEIVING: ConflictRow = {
  ...CREATING,
  conflictFileIsMine: false,
  mine: { device: "Laptop A", time: new Date(2026, 9, 21, 14, 5).getTime(), size: 38 },
  theirs: { device: "Laptop B", time: new Date(2026, 9, 21, 14, 7).getTime(), size: 40 },
};

Deno.test("conflict-review-view - the row names the file over its folder", () => {
  assertEquals(fileName(PATH), "Plan.md");
  assertEquals(fileName("Plan.md"), "Plan.md");
  assertEquals(folderLine(PATH), "Notes/");
  assertEquals(folderLine("a/b/Plan.md"), "a/b/");
  assertEquals(folderLine("Plan.md"), "");
});

Deno.test("conflict-review-view - the title names the reviewed file", () => {
  assertEquals(reviewTitle(PATH), "Review · Plan.md");
});

Deno.test("conflict-review-view - dateStamp carries the date and the time", () => {
  assertEquals(dateStamp(new Date(2026, 9, 21, 14, 5).getTime()), "21 Oct 2026, 14:05");
  assertEquals(dateStamp(new Date(2026, 2, 5, 9, 7).getTime()), "5 Mar 2026, 09:07");
});

Deno.test("conflict-review-view - a version with no known time is never a bare clock time", () => {
  const row: ConflictRow = {
    ...CREATING,
    mine: { ...CREATING.mine, time: null },
  };
  assertEquals(reviewKeys(row).conflict.when, NO_DATE);
});

Deno.test("conflict-review-view - the key names each file with its device, date and time on both devices", () => {
  for (const row of [CREATING, RECEIVING]) {
    const { original, conflict } = reviewKeys(row);
    assertEquals(original, {
      label: "Original",
      path: PATH,
      name: "Plan.md",
      device: "Laptop A",
      when: "21 Oct 2026, 14:05",
    });
    assertEquals(conflict, {
      label: "Conflict",
      path: CONFLICT_PATH,
      name: "Plan (conflict Laptop B 2026-10-21 1405).md",
      device: "Laptop B",
      when: "21 Oct 2026, 14:07",
    });
  }
});

Deno.test("conflict-review-view - keep original keeps row.path, keep conflict keeps row.conflictPath", () => {
  assertEquals(keepActions(CREATING), { original: "keep-theirs", conflict: "keep-mine" });
  assertEquals(keepActions(RECEIVING), { original: "keep-mine", conflict: "keep-theirs" });
});

Deno.test("conflict-review-view - the keep mapping matches the planner on both devices", () => {
  for (const row of [CREATING, RECEIVING]) {
    const actions = keepActions(row);
    // Keep original writes nothing: only the set aside file goes.
    assertEquals(planResolution(row, actions.original), { delete: row.conflictPath });
    // Keep conflict puts the set aside edit under the original name.
    assertEquals(planResolution(row, actions.conflict), {
      write: { path: row.path, source: row.conflictPath },
      delete: row.conflictPath,
    });
  }
});

Deno.test("conflict-review-view - comparedLines colors each version's own lines, shared lines stay plain", () => {
  const original = "# Plan\nfirst\nshared\nlast";
  const conflict = "# Plan\nsecond\nshared\nlast";
  assertEquals(comparedLines(original, conflict), [
    { kind: "same", text: "# Plan" },
    { kind: "original", text: "first" },
    { kind: "conflict", text: "second" },
    { kind: "same", text: "shared" },
    { kind: "same", text: "last" },
  ]);
});

Deno.test("conflict-review-view - comparedLines stacks both variants where both sides changed", () => {
  const original = "a\nmine\nb";
  const conflict = "a\nmine\ntheirs";
  assertEquals(comparedLines(original, conflict), [
    { kind: "same", text: "a" },
    { kind: "same", text: "mine" },
    { kind: "original", text: "b" },
    { kind: "conflict", text: "theirs" },
  ]);
});

Deno.test("conflict-review-view - comparedLines adds no + or minus prefixes and keeps identical texts plain", () => {
  const lines = comparedLines("# A\nbody", "# A\nan extra paragraph");
  assertEquals(lines, [
    { kind: "same", text: "# A" },
    { kind: "original", text: "body" },
    { kind: "conflict", text: "an extra paragraph" },
  ]);
  assertEquals(comparedLines("# A\nbody", "# A\nbody"), [
    { kind: "same", text: "# A" },
    { kind: "same", text: "body" },
  ]);
  for (const line of lines) {
    assertEquals(/^[+−-]/.test(line.text), false, line.text);
  }
});

Deno.test("conflict-review-view - user copy carries no hyphens or dashes", () => {
  const copy = [
    REVIEW_BUTTON,
    OPEN_BOTH_LINK,
    BACK_BUTTON,
    KEEP_ORIGINAL_BUTTON,
    KEEP_CONFLICT_BUTTON,
    KEEP_BOTH_BUTTON,
    CONFLICT_GONE,
    NO_DATE,
    READ_FAILED,
    reviewTitle("Notes/Plan.md"),
  ];
  for (const text of copy) assertEquals(/[\u2013\u2014-]/.test(text), false, text);
});
