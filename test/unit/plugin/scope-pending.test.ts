import { assert, assertEquals } from "@std/assert";
import {
  destFolderOf,
  dropPendingEntries,
  isParkedMove,
  isPathInCatchUp,
  MOVE_OUT_CAP,
  parkedMoveAt,
  parkMoveOut,
  type PendingMoveOut,
  pruneMoveOuts,
  repointMoveOut,
} from "../../../plugin/plumbing/scope-pending.ts";
import { DEFAULT_SETTINGS, otherCatchUpEntry } from "../../../plugin/plumbing/settings-types.ts";

const cfg = ".obsidian";

Deno.test("isPathInCatchUp - file entries match exact, not a longer same-name path", () => {
  // An exact-file prefix must not match a sibling like hotkeys.json.bak.
  assert(isPathInCatchUp(".obsidian/hotkeys.json", [".obsidian/hotkeys.json"], cfg));
  assert(!isPathInCatchUp(".obsidian/hotkeys.json.bak", [".obsidian/hotkeys.json"], cfg));
  assert(!isPathInCatchUp(".obsidian/hotkeys.json2", [".obsidian/hotkeys.json"], cfg));
});

Deno.test("isPathInCatchUp - dir entries match by prefix", () => {
  assert(isPathInCatchUp(".obsidian/snippets/a.css", [".obsidian/snippets/"], cfg));
  assert(!isPathInCatchUp(".obsidian/snippetsX/a.css", [".obsidian/snippets/"], cfg));
});

Deno.test("isPathInCatchUp - the other sentinel matches by classifier, not path", () => {
  const other = otherCatchUpEntry(cfg);
  assert(isPathInCatchUp(".obsidian/app.json", [other], cfg));
  assert(isPathInCatchUp(".obsidian/unknown-token.json", [other], cfg));
  // Not other-scoped: themes, hotkeys, and non-config paths stay out.
  assert(!isPathInCatchUp(".obsidian/themes/x.css", [other], cfg));
  assert(!isPathInCatchUp(".obsidian/hotkeys.json", [other], cfg));
  assert(!isPathInCatchUp("notes/a.md", [other], cfg));
});

Deno.test("dropPendingEntries - drops a category's prefixes, keeps siblings", async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    pendingCatchUpFolders: [".obsidian/hotkeys.json", ".obsidian/snippets/"],
  };
  let saved = 0;
  await dropPendingEntries(settings, [".obsidian/hotkeys.json"], () => {
    saved++;
    return Promise.resolve();
  });
  assertEquals(settings.pendingCatchUpFolders, [".obsidian/snippets/"]);
  assertEquals(saved, 1);
  // No-op (no save) when nothing to drop.
  await dropPendingEntries(settings, [".obsidian/hotkeys.json"], () => {
    saved++;
    return Promise.resolve();
  });
  assertEquals(saved, 1);
});

function entry(i = 0): PendingMoveOut {
  return { oldPath: `notes/n${i}.md`, destFolder: "Projects/" };
}

function ctx(
  overrides: Partial<Parameters<typeof pruneMoveOuts>[1]> = {},
): Parameters<typeof pruneMoveOuts>[1] {
  return {
    excludedFolders: ["Projects/"],
    includedFolders: [],
    pendingCatchUpFolders: [],
    reIncludedFolders: [],
    hasRow: () => true,
    ...overrides,
  };
}

Deno.test("pruneMoveOuts - keeps a live entry while its destination is still excluded", () => {
  const { remaining, completed, dropped } = pruneMoveOuts([entry()], ctx());
  assertEquals(remaining, [entry()]);
  assertEquals(completed, []);
  assertEquals(dropped, []);
});

Deno.test("pruneMoveOuts - completes a move once the destination is re-included", () => {
  const { remaining, completed } = pruneMoveOuts(
    [entry()],
    ctx({ excludedFolders: [], reIncludedFolders: ["Projects/"] }),
  );
  assertEquals(remaining, []);
  assertEquals(completed, [entry()]);
});

Deno.test("pruneMoveOuts - completes a move once the destination is in scope and not pending", () => {
  const { remaining, completed } = pruneMoveOuts(
    [entry()],
    ctx({ excludedFolders: [] }),
  );
  assertEquals(remaining, []);
  assertEquals(completed, [entry()]);
});

Deno.test("pruneMoveOuts - keeps a re-included-but-pending destination's entry (catch-up not done)", () => {
  const { remaining, completed } = pruneMoveOuts(
    [entry()],
    ctx({ excludedFolders: [], pendingCatchUpFolders: ["Projects/"] }),
  );
  assertEquals(remaining, [entry()]);
  assertEquals(completed, []);
});

Deno.test("pruneMoveOuts - drops a dead entry whose source row is gone", () => {
  const { remaining, dropped } = pruneMoveOuts([entry()], ctx({ hasRow: () => false }));
  assertEquals(remaining, []);
  assertEquals(dropped, [entry()]);
});

Deno.test("pruneMoveOuts - caps the list at MOVE_OUT_CAP, dropping the oldest first", () => {
  const entries = Array.from({ length: MOVE_OUT_CAP + 5 }, (_, i) => entry(i));
  const { remaining, dropped } = pruneMoveOuts(entries, ctx());
  assertEquals(remaining.length, MOVE_OUT_CAP);
  assertEquals(dropped.length, 5);
  assertEquals(remaining[0], entry(5), "oldest entries dropped first");
  assertEquals(remaining[remaining.length - 1], entry(MOVE_OUT_CAP + 4));
});

// ── #584: the parked move's destination ────────────────────────────────

function parked(oldPath: string, destPath: string): PendingMoveOut {
  return { oldPath, destPath, destFolder: destFolderOf(destPath) };
}

Deno.test("destFolderOf - keeps the trailing slash, root files have none", () => {
  assertEquals(destFolderOf("Archive/a.md"), "Archive/");
  assertEquals(destFolderOf("Archive/deep/a.md"), "Archive/deep/");
  assertEquals(destFolderOf("a.md"), "");
});

Deno.test("parkedMoveAt - finds the file parked under a name, ignores a plain entry", () => {
  const entries = [entry(0), parked("notes/n1.md", "Archive/n1.md")];
  assertEquals(parkedMoveAt(entries, "Archive/n1.md")?.oldPath, "notes/n1.md");
  assertEquals(parkedMoveAt(entries, "notes/n0.md"), undefined);
});

Deno.test("isParkedMove - true while the old name is parked, false once it resolves", () => {
  assert(isParkedMove([parked("notes/n1.md", "Archive/n1.md")], "notes/n1.md"));
  assert(!isParkedMove([], "notes/n1.md"));
});

Deno.test("parkMoveOut - one parked move per file, the newest destination wins", () => {
  const first = parkMoveOut([], parked("notes/n1.md", "Archive/n1.md"));
  const second = parkMoveOut(first.entries, parked("notes/n1.md", "Other/n1.md"));
  assertEquals(second.entries, [parked("notes/n1.md", "Other/n1.md")]);
  assertEquals(second.displaced, [], "the same file re-parked displaces nothing");
});

Deno.test("parkMoveOut - a park onto another parked name displaces that file", () => {
  const entries = [parked("notes/x.md", "Archive/x.md")];
  const update = parkMoveOut(entries, parked("notes/y.md", "Archive/x.md"));
  assertEquals(update.entries, [parked("notes/y.md", "Archive/x.md")]);
  assertEquals(update.displaced, [parked("notes/x.md", "Archive/x.md")], "its row is released");
});

Deno.test("repointMoveOut - a move inside the excluded area re-points the destination", () => {
  const entries = [parked("notes/n1.md", "Archive/n1.md")];
  const next = repointMoveOut(entries, "Archive/n1.md", "Archive/deep/n1.md");
  assertEquals(next?.entries, [parked("notes/n1.md", "Archive/deep/n1.md")]);
  assertEquals(next?.displaced, []);
  assertEquals(entries[0].destPath, "Archive/n1.md", "the input list is not mutated");
});

Deno.test("repointMoveOut - re-pointing onto another parked name displaces that file", () => {
  const entries = [parked("notes/x.md", "Archive/x.md"), parked("notes/y.md", "Archive/y.md")];
  const next = repointMoveOut(entries, "Archive/y.md", "Archive/x.md");
  assertEquals(next?.entries, [parked("notes/y.md", "Archive/x.md")]);
  assertEquals(next?.displaced, [parked("notes/x.md", "Archive/x.md")]);
});

Deno.test("repointMoveOut - nothing parked at that name: null, so an ordinary move is untouched", () => {
  assertEquals(
    repointMoveOut([parked("notes/n1.md", "Archive/n1.md")], "Archive/x.md", "Archive/y.md"),
    null,
  );
});
