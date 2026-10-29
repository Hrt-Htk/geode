import {
  planResolution,
  type ResolutionAction,
  resolutionLabel,
} from "../../../plugin/sync/conflict-resolve.ts";
import { assertEquals } from "@std/assert";

// #432: the resolution planner is obsidian-free and pure: it decides what to
// write, delete and rename per action. The conflict file is attributed to its
// creator: on the creating device (conflictFileIsMine) it holds this device's
// version; on a device it arrived on it holds the other device's, so Keep
// mine / Keep theirs invert there. Only whole versions move; no marker content
// is ever written.

const MINE = {
  path: "Notes/Meeting notes.md",
  conflictPath: "Notes/Meeting notes (conflict Laptop 2026-10-14 1405).md",
  conflictFileIsMine: true,
};

const THEIRS = { ...MINE, conflictFileIsMine: false };

Deno.test("creating device: keep mine writes the conflict file over the original, then deletes it", () => {
  assertEquals(planResolution(MINE, "keep-mine"), {
    write: { path: MINE.path, source: MINE.conflictPath },
    delete: MINE.conflictPath,
  });
});

Deno.test("creating device: keep theirs deletes the conflict file; the original holds the server copy", () => {
  assertEquals(planResolution(MINE, "keep-theirs"), { delete: MINE.conflictPath });
});

Deno.test("receiving device: keep mine keeps the original, deletes the conflict file (inverted)", () => {
  assertEquals(planResolution(THEIRS, "keep-mine"), { delete: THEIRS.conflictPath });
});

Deno.test("receiving device: keep theirs writes the conflict file over the original (inverted)", () => {
  assertEquals(planResolution(THEIRS, "keep-theirs"), {
    write: { path: THEIRS.path, source: THEIRS.conflictPath },
    delete: THEIRS.conflictPath,
  });
});

Deno.test("keep both renames the conflict file beside the original on either device", () => {
  assertEquals(planResolution(MINE, "keep-both"), {
    rename: { from: MINE.conflictPath, to: "Notes/Meeting notes (kept copy).md" },
  });
  assertEquals(planResolution(THEIRS, "keep-both"), {
    rename: { from: THEIRS.conflictPath, to: "Notes/Meeting notes (kept copy).md" },
  });
});

Deno.test("every plan deletes or renames the conflict file away", () => {
  for (const row of [MINE, THEIRS]) {
    for (const action of ["keep-mine", "keep-theirs", "keep-both"] as ResolutionAction[]) {
      const plan = planResolution(row, action);
      const gone = plan.delete === row.conflictPath || plan.rename?.from === row.conflictPath;
      assertEquals(
        gone,
        true,
        `plan for ${action} (mine=${row.conflictFileIsMine}) must remove the conflict file`,
      );
    }
  }
});

Deno.test("resolutionLabel names the kept side for the activity line and notice", () => {
  assertEquals(resolutionLabel("keep-mine", "This laptop", null), "kept This laptop's version");
  assertEquals(resolutionLabel("keep-theirs", "This laptop", "Phone"), "kept Phone's version");
  assertEquals(
    resolutionLabel("keep-theirs", "This laptop", null),
    "kept Another device's version",
  );
  assertEquals(resolutionLabel("keep-both", "This laptop", "Phone"), "kept both");
});
