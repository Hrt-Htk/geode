// #601: the review window's logic: folder tree, per-folder state, the shared per-file
// selection, the main button's label, and every string the window shows.

import { assert, assertEquals } from "@std/assert";
import {
  confirmMessage,
  confirmTitle,
  copyText,
  filesMissing,
  folderLabel,
  folderState,
  formatCount,
  formatDay,
  holdNoticeText,
  mainAction,
  missingTree,
  recentFirst,
  rootFiles,
  rootState,
  selectAllFiles,
  selectRootFiles,
  selectSubtree,
  toggleFile,
  trashNote,
} from "../../../plugin/ui/mass-delete-review.ts";
import type { HeldFile } from "../../../plugin/sync/mass-delete-hold.ts";

function file(path: string, mtime: number): HeldFile {
  return { path, mtime };
}

const FILES: HeldFile[] = [
  file("Archive/2023/Q1/a.md", 1),
  file("Archive/2023/Q1/b.md", 2),
  file("Archive/2023/Q2/c.md", 3),
  file("Daily/d.md", 4),
  file("root.md", 5),
];

function node(nodes: ReturnType<typeof missingTree>, path: string) {
  const walk = (list: typeof nodes): (typeof nodes)[number] | undefined => {
    for (const n of list) {
      if (n.path === path) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
  };
  const hit = walk(nodes);
  assert(hit, `missing folder node ${path}`);
  return hit;
}

Deno.test("mass-delete-review - counts every missing file and its folders, A to Z", () => {
  const tree = missingTree(FILES, new Set());

  assertEquals(tree.map((n) => n.name), ["Archive", "Daily"], "folders only, no root file node");
  assertEquals(node(tree, "Archive/").count, 3);
  assertEquals(node(tree, "Archive/2023/").count, 3);
  assertEquals(node(tree, "Archive/2023/Q1/").count, 2);
  assertEquals(node(tree, "Archive/2023/Q2/").count, 1);
  assertEquals(node(tree, "Daily/").count, 1);
  assertEquals(node(tree, "Daily/").children, []);
});

Deno.test("mass-delete-review - a folder is all, partial or none by its selected files", () => {
  const all = missingTree(FILES, new Set(FILES.map((f) => f.path)));
  assertEquals(folderState(node(all, "Archive/")), "all");
  assertEquals(folderState(node(all, "Daily/")), "all");

  const none = missingTree(FILES, new Set());
  assertEquals(folderState(node(none, "Archive/")), "none");

  const partial = missingTree(FILES, new Set(["Archive/2023/Q1/a.md"]));
  assertEquals(folderState(node(partial, "Archive/")), "partial");
  assertEquals(folderState(node(partial, "Archive/2023/")), "partial");
  assertEquals(folderState(node(partial, "Archive/2023/Q1/")), "partial");
  assertEquals(folderState(node(partial, "Archive/2023/Q2/")), "none");

  const wholeSubtree = missingTree(
    FILES,
    new Set(["Archive/2023/Q1/a.md", "Archive/2023/Q1/b.md"]),
  );
  assertEquals(folderState(node(wholeSubtree, "Archive/2023/Q1/")), "all");
  assertEquals(folderState(node(wholeSubtree, "Archive/2023/")), "partial");
});

Deno.test("mass-delete-review - one folder tap selects or clears exactly its subtree", () => {
  const on = selectSubtree(FILES, new Set(["Daily/d.md"]), "Archive/2023/", true);
  assertEquals(on.sort(), [
    "Archive/2023/Q1/a.md",
    "Archive/2023/Q1/b.md",
    "Archive/2023/Q2/c.md",
    "Daily/d.md",
  ]);

  const off = selectSubtree(
    FILES,
    new Set(["Archive/2023/Q1/a.md", "Archive/2023/Q1/b.md", "Daily/d.md"]),
    "Archive/2023/",
    false,
  );
  assertEquals(off, ["Daily/d.md"], "only the other folder's file stays selected");

  const rootFile = selectSubtree(FILES, new Set(), "Archive/", true);
  assertEquals(rootFile.includes("root.md"), false, "a root file is in no folder");
});

Deno.test("mass-delete-review - a file toggle and select all edit the same set", () => {
  assertEquals(toggleFile(new Set(), "Daily/d.md", true), ["Daily/d.md"]);
  assertEquals(toggleFile(new Set(["Daily/d.md"]), "Daily/d.md", false), []);
  assertEquals(selectAllFiles(FILES, true).length, FILES.length);
  assertEquals(selectAllFiles(FILES, false), []);
});

Deno.test("mass-delete-review - Recent is newest first, by the last known mtime", () => {
  assertEquals(recentFirst(FILES).map((f) => f.path), [
    "root.md",
    "Daily/d.md",
    "Archive/2023/Q2/c.md",
    "Archive/2023/Q1/b.md",
    "Archive/2023/Q1/a.md",
  ]);
  assertEquals(FILES[0].path, "Archive/2023/Q1/a.md", "the input order is not mutated");
});

Deno.test("mass-delete-review - the main button names both counts and its tone", () => {
  assertEquals(mainAction(1850, 0), { label: "Restore 1,850 files", tone: "restore" });
  assertEquals(mainAction(1850, 1850), { label: "Delete 1,850 files", tone: "delete" });
  assertEquals(mainAction(1850, 1370), {
    label: "Delete 1,370 files, restore 480",
    tone: "delete",
  });
  assertEquals(mainAction(1, 0).label, "Restore 1 file", "a single file is not plural");
});

Deno.test("mass-delete-review - the count line reads as a number and a noun", () => {
  assertEquals(filesMissing(1850), "1,850 files missing");
  assertEquals(filesMissing(1), "1 file missing");
});

Deno.test("mass-delete-review - the detection notice is one line, with the device's verb", () => {
  assertEquals(
    holdNoticeText(1850, false),
    "1,850 files missing. Sync is on hold. Click to review.",
  );
  assertEquals(
    holdNoticeText(1850, true),
    "1,850 files missing. Sync is on hold. Tap to review.",
  );
  assertEquals(holdNoticeText(1, false), "1 file missing. Sync is on hold. Click to review.");
});

Deno.test("mass-delete-review - the confirmation counts what is deleted and what is restored", () => {
  assertEquals(confirmTitle(1800), "Delete 1,800 files on all devices?");
  assertEquals(confirmMessage(0, 30), "They stay in the trash for 30 days.");
  assertEquals(
    confirmMessage(50, 30),
    "They stay in the trash for 30 days. 50 files are restored.",
  );
});

Deno.test("mass-delete-review - the trash promise follows the effective retention", () => {
  assertEquals(trashNote(30), "Deleted files stay in the trash for 30 days.");
  assertEquals(trashNote(1), "Deleted files stay in the trash for 1 day.");
  assertEquals(confirmMessage(0, 1), "They stay in the trash for 1 day.");
  assertEquals(trashNote(7), "Deleted files stay in the trash for 7 days.");
});

Deno.test("mass-delete-review - root files are their own bottom row, not a folder", () => {
  assertEquals(rootFiles(FILES).map((f) => f.path), ["root.md"]);
  assertEquals(
    missingTree(FILES, new Set()).map((n) => n.name),
    ["Archive", "Daily"],
    "no root node",
  );

  // Selecting the root row touches only root files; selecting a folder leaves it alone.
  const rootOn = selectRootFiles(FILES, new Set(["Daily/d.md"]), true);
  assertEquals(rootOn.sort(), ["Daily/d.md", "root.md"]);
  assertEquals(selectRootFiles(FILES, new Set(["Daily/d.md", "root.md"]), false), ["Daily/d.md"]);

  assertEquals(rootState(FILES, new Set()), "none");
  assertEquals(rootState(FILES, new Set(["root.md"])), "all", "one root file, one selected");
  assertEquals(
    rootState(FILES, new Set(["Daily/d.md"])),
    "none",
    "a folder file is not a root file",
  );

  const twoRoots = [...FILES, file("other.md", 6)];
  assertEquals(rootState(twoRoots, new Set(["root.md"])), "partial");
  assertEquals(rootState(twoRoots, new Set(["root.md", "other.md"])), "all");
  assertEquals(selectRootFiles(twoRoots, new Set(), true).sort(), ["other.md", "root.md"]);
});

Deno.test("mass-delete-review - the copied list is every held path, sorted, one per line", () => {
  assertEquals(copyText(FILES).split("\n"), [
    "Archive/2023/Q1/a.md",
    "Archive/2023/Q1/b.md",
    "Archive/2023/Q2/c.md",
    "Daily/d.md",
    "root.md",
  ]);
  assertEquals(copyText(FILES), copyText([...FILES].reverse()), "selection order never leaks out");
});

Deno.test("mass-delete-review - counts and days use the tooltip format", () => {
  assertEquals(formatCount(1850), "1,850");
  assertEquals(formatCount(480), "480");
  assertEquals(formatCount(0), "0");
  assertEquals(formatDay(new Date(2026, 9, 8, 12).getTime()), "8 Oct 2026");
  assertEquals(folderLabel("Archive/2023/Q1/a.md"), "Archive/2023/Q1/");
  assertEquals(folderLabel("root.md"), "/");
});
