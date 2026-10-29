import { assertEquals } from "@std/assert";
import {
  conflictDeviceLabel,
  conflictDeviceName,
  generateConflictPath,
  isConflictPath,
  originalPathOf,
  sanitizeDeviceName,
  splitExt,
} from "../../../plugin/sync/conflicts.ts";

// #432: the conflict file name format. Names embed the device that made the
// losing edit for easy comparison in the file list:
// "a (conflict Laptop 2026-10-12 140205).md" (seconds-granular so two conflicts
// on one path within a minute never collide). The old ".conflict-<timestamp>"
// form and the earlier minute-only "(conflict … HHMM)" form stay recognized.

const TS = new Date(2026, 9, 12, 14, 2, 5); // local 2026-10-12 14:02:05

Deno.test("generateConflictPath embeds the device name and a second-granular timestamp", () => {
  assertEquals(
    generateConflictPath("Meeting notes.md", "Laptop", TS),
    "Meeting notes (conflict Laptop 2026-10-12 140205).md",
  );
  assertEquals(
    generateConflictPath("Attachments/photo_2026-10-11.jpg", "Phone", TS),
    "Attachments/photo_2026-10-11 (conflict Phone 2026-10-12 140205).jpg",
  );
  assertEquals(
    generateConflictPath("data", "Laptop", TS),
    "data (conflict Laptop 2026-10-12 140205)",
  );
});

Deno.test("generateConflictPath sanitizes the device name for file systems", () => {
  const nasty = 'My "Work" Laptop: Pro/1\\2*3?4<5>6|7';
  assertEquals(
    generateConflictPath("a.md", nasty, TS),
    "a (conflict My Work Laptop Pro 1 2 3 4 5 6 7 2026-10-12 140205).md",
  );
  // Empty or blank names fall back to a neutral label.
  assertEquals(
    generateConflictPath("a.md", "", TS),
    "a (conflict This device 2026-10-12 140205).md",
  );
  assertEquals(
    generateConflictPath("a.md", "   ", TS),
    "a (conflict This device 2026-10-12 140205).md",
  );
});

Deno.test("generateConflictPath caps the device name length", () => {
  const out = generateConflictPath("a.md", "A".repeat(100), TS);
  assertEquals(isConflictPath(out), true);
  assertEquals(originalPathOf(out), "a.md");
  // The sanitized name in the file is at most the cap.
  const inside = out.match(/\(conflict (.+?) \d{4}-\d{2}-\d{2} \d{4,6}\)/);
  assertEquals(inside![1].length <= 40, true);
});

Deno.test("a name that sanitizes to empty embeds the neutral label (the same label comparison uses)", () => {
  assertEquals(conflictDeviceLabel("///"), "This device");
  assertEquals(
    generateConflictPath("a.md", "///", TS),
    "a (conflict This device 2026-10-12 140205).md",
  );
  // The label is the same string conflictFileIsMine compares against.
  assertEquals(
    conflictDeviceLabel("///"),
    conflictDeviceName("a (conflict This device 2026-10-12 140205).md"),
  );
});

Deno.test("isConflictPath recognizes the new (conflict <device> <stamp>) form", () => {
  assertEquals(isConflictPath("Notes/Meeting notes (conflict Laptop 2026-10-12 140205).md"), true);
  assertEquals(isConflictPath("photo (conflict Phone 2026-10-14 140500).jpg"), true);
  assertEquals(isConflictPath("data (conflict Laptop 2026-10-12 140205)"), true);
});

Deno.test("isConflictPath still recognizes the earlier minute-only form and the old .conflict- form", () => {
  // Minute-only "(conflict … HHMM)" form from the first #432 iteration.
  assertEquals(isConflictPath("Notes/Meeting notes (conflict Laptop 2026-10-12 1402).md"), true);
  // Old ".conflict-<timestamp>" form.
  assertEquals(isConflictPath("Notes/Meeting notes.conflict-2026-10-14T14-05-00.md"), true);
  assertEquals(isConflictPath("photo.conflict-2026-10-11T12-47-00.jpg"), true);
  assertEquals(isConflictPath("data.conflict-2026-01-01T00-00-00"), true);
});

Deno.test("isConflictPath recognizes the uniqueness-suffixed form (a counter inside the marker)", () => {
  assertEquals(
    isConflictPath("Notes/Meeting notes (conflict Laptop 2026-10-12 140205 2).md"),
    true,
  );
  assertEquals(isConflictPath("data (conflict Laptop 2026-10-12 140205 3)"), true);
});

Deno.test("isConflictPath does not mis-detect prose '(conflict' names", () => {
  assertEquals(isConflictPath("My (conflict) notes.md"), false);
  assertEquals(isConflictPath("notes (conflict).md"), false);
  assertEquals(isConflictPath("notes (conflict Laptop).md"), false); // no stamp
  assertEquals(isConflictPath("notes (conflict Laptop 2026-10-12).md"), false); // no time
  assertEquals(isConflictPath("notes.md"), false);
  assertEquals(isConflictPath("notes.conflict.md"), false);
  assertEquals(isConflictPath("notes.conflict-2026.md"), false);
});

Deno.test("originalPathOf maps the new form back to the original", () => {
  assertEquals(
    originalPathOf("Notes/Meeting notes (conflict Laptop 2026-10-12 140205).md"),
    "Notes/Meeting notes.md",
  );
  assertEquals(
    originalPathOf("photo_2026-10-11 (conflict Phone 2026-10-11 124700).jpg"),
    "photo_2026-10-11.jpg",
  );
  assertEquals(originalPathOf("data (conflict Laptop 2026-01-01 000000)"), "data");
});

Deno.test("originalPathOf maps the minute-only, suffixed and old forms back to the original", () => {
  assertEquals(
    originalPathOf("Notes/Meeting notes (conflict Laptop 2026-10-12 1402).md"),
    "Notes/Meeting notes.md",
  );
  assertEquals(
    originalPathOf("Notes/Meeting notes (conflict Laptop 2026-10-12 140205 2).md"),
    "Notes/Meeting notes.md",
  );
  assertEquals(
    originalPathOf("Notes/Meeting notes.conflict-2026-10-14T14-05-00.md"),
    "Notes/Meeting notes.md",
  );
  assertEquals(originalPathOf("photo.conflict-2026-10-11T12-47-00.jpg"), "photo.jpg");
  assertEquals(originalPathOf("data.conflict-2026-01-01T00-00-00"), "data");
});

Deno.test("originalPathOf returns null for non-conflict paths", () => {
  assertEquals(originalPathOf("notes.md"), null);
  assertEquals(originalPathOf("notes (conflict Laptop).md"), null);
});

Deno.test("conflictDeviceName extracts the creator from the new form (any granularity)", () => {
  assertEquals(
    conflictDeviceName("Meeting notes (conflict Laptop 2026-10-12 140205).md"),
    "Laptop",
  );
  assertEquals(
    conflictDeviceName("a (conflict My Work Laptop 2026-10-12 140205).md"),
    "My Work Laptop",
  );
  assertEquals(conflictDeviceName("a (conflict Laptop 2026-10-12 1402).md"), "Laptop");
  assertEquals(conflictDeviceName("a (conflict Laptop 2026-10-12 140205 2).md"), "Laptop");
  assertEquals(conflictDeviceName("a.conflict-2026-10-12T14-02-00.md"), null);
  assertEquals(conflictDeviceName("notes.md"), null);
});

Deno.test("sanitizeDeviceName strips forbidden characters and trims", () => {
  assertEquals(sanitizeDeviceName('My "Work": Laptop/1'), "My Work Laptop 1");
  assertEquals(sanitizeDeviceName("  Phone  "), "Phone");
  assertEquals(sanitizeDeviceName("A".repeat(100)).length, 40);
});

Deno.test("splitExt splits the last extension from the stem", () => {
  assertEquals(splitExt("Notes/a.md"), { stem: "Notes/a", ext: ".md" });
  assertEquals(splitExt("photo.jpg"), { stem: "photo", ext: ".jpg" });
  assertEquals(splitExt("data"), { stem: "data", ext: "" });
  assertEquals(splitExt("dir.with.dots/file"), { stem: "dir.with.dots/file", ext: "" });
});
