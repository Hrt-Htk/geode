import {
  conflictFileIsMine,
  type ConflictRow,
  conflictType,
  countConflictFiles,
  filterConflictRows,
  formatSize,
  keptConflictPath,
  typeLabel,
} from "../../../plugin/sync/conflict-list.ts";
import { assertEquals } from "@std/assert";

// #432: the conflicts list model is obsidian-free: original-path recovery,
// type detection, kept-copy naming, path search, and the mine/theirs split.

Deno.test("conflictType detects note, image, pdf and other from the extension", () => {
  assertEquals(conflictType("Notes/Meeting notes.md"), "note");
  assertEquals(conflictType("photo.jpg"), "image");
  assertEquals(conflictType("deep/dir/pic.PNG"), "image");
  assertEquals(conflictType("scan.pdf"), "pdf");
  assertEquals(conflictType("data.txt"), "other");
  assertEquals(conflictType("noext"), "other");
});

Deno.test("typeLabel renders the compact uppercase tag", () => {
  assertEquals(typeLabel("note"), "NOTE");
  assertEquals(typeLabel("image"), "IMAGE");
  assertEquals(typeLabel("pdf"), "PDF");
  assertEquals(typeLabel("other"), "FILE");
});

Deno.test("keptConflictPath renames beside the original with a kept copy suffix", () => {
  assertEquals(
    keptConflictPath("Notes/Meeting notes.md"),
    "Notes/Meeting notes (kept copy).md",
  );
  assertEquals(keptConflictPath("photo.jpg"), "photo (kept copy).jpg");
  assertEquals(keptConflictPath("data"), "data (kept copy)");
});

Deno.test("conflictFileIsMine: the embedded device name is authoritative", () => {
  const path = "Notes/a (conflict Laptop B 2026-10-12 1402).md";
  // Matches this device's name → mine.
  assertEquals(conflictFileIsMine(path, "Laptop B", null, "id-A"), true);
  // A different device's name → theirs.
  assertEquals(conflictFileIsMine(path, "Laptop A", null, "id-A"), false);
  // A conflict created by a nameless device embeds the neutral label; a
  // nameless device sees it as its own.
  const neutral = "Notes/a (conflict This device 2026-10-12 1402).md";
  assertEquals(conflictFileIsMine(neutral, "", null, "id-A"), true);
  assertEquals(conflictFileIsMine(neutral, "Laptop A", null, "id-A"), false);
});

Deno.test("conflictFileIsMine: a device name that sanitizes to empty is its own conflict (shared label)", () => {
  const neutral = "Notes/a (conflict This device 2026-10-12 140205).md";
  // "///" sanitizes to "" but the shared label embeds "This device", so the
  // creating device (also "///") recognizes it as mine and Keep mine/theirs
  // do not invert.
  assertEquals(conflictFileIsMine(neutral, "///", null, "id-A"), true);
  assertEquals(conflictFileIsMine(neutral, "Laptop A", null, "id-A"), false);
});

Deno.test("countConflictFiles counts open conflict files across every form, on any device", () => {
  const files = [
    { path: "a (conflict Laptop 2026-10-12 140205).md" },
    { path: "b (conflict Phone 2026-10-12 1402).md" },
    { path: "c (conflict Tablet 2026-10-12 140205 2).md" },
    { path: "d.conflict-2026-10-14T14-05-00.md" },
    { path: "notes.md" },
    { path: "notes (conflict Laptop).md" },
  ];
  assertEquals(countConflictFiles(files), 4);
  assertEquals(countConflictFiles([]), 0);
  assertEquals(countConflictFiles([{ path: "notes.md" }]), 0);
});

Deno.test("conflictFileIsMine: old-format files without a name use the server head's device", () => {
  const oldPath = "Notes/a.conflict-2026-10-14T14-05-00.md";
  assertEquals(conflictFileIsMine(oldPath, "Laptop B", "id-B", "id-B"), true);
  assertEquals(conflictFileIsMine(oldPath, "Laptop A", "id-B", "id-A"), false);
  assertEquals(conflictFileIsMine(oldPath, "Laptop A", null, "id-A"), false);
});

Deno.test("filterConflictRows matches the path case-insensitively; empty query keeps all", () => {
  const rows: ConflictRow[] = [
    {
      path: "Notes/Meeting notes.md",
      conflictPath: "Notes/Meeting notes (conflict Laptop 2026-10-14 1405).md",
      type: "note",
      conflictFileIsMine: true,
      mine: { device: "Laptop", time: 0, size: null },
      theirs: { device: "Phone", time: 0, size: null },
    },
    {
      path: "Attachments/photo.jpg",
      conflictPath: "Attachments/photo (conflict Phone 2026-10-11 1247).jpg",
      type: "image",
      conflictFileIsMine: false,
      mine: { device: "Laptop", time: 0, size: null },
      theirs: { device: "Phone", time: 0, size: null },
    },
  ];
  assertEquals(filterConflictRows(rows, "").length, 2);
  assertEquals(filterConflictRows(rows, "   ").length, 2);
  assertEquals(filterConflictRows(rows, "meeting").map((r) => r.path), ["Notes/Meeting notes.md"]);
  assertEquals(filterConflictRows(rows, "ATTACHMENTS").map((r) => r.path), [
    "Attachments/photo.jpg",
  ]);
  assertEquals(filterConflictRows(rows, "zzz").length, 0);
});

Deno.test("formatSize renders bytes, KB and MB", () => {
  assertEquals(formatSize(512), "512 B");
  assertEquals(formatSize(2048), "2.0 KB");
  assertEquals(formatSize(5 * 1024 * 1024), "5.0 MB");
});
