// #695: a file that turns up at a name a peer renamed away is that note's late save
// only when most of the renamed note's text is still in it.
import { assertEquals } from "@std/assert";
import { isLateSave } from "../../../plugin/sync/late-save.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Ten 9-character lines: a kept line is worth 10 characters, so 8 of 10 lines is
 * exactly 80% of the 100-character note. */
const DEST_TEXT = "abcdefghi\n".repeat(10);
const DEST = bytes(DEST_TEXT);

Deno.test("late save - an empty or whitespace-only file is a new note", () => {
  assertEquals(isLateSave(bytes(""), DEST), false);
  assertEquals(isLateSave(bytes(" \n\t\n  \n"), DEST), false);
});

Deno.test("late save - a renamed note missing from disk is a new note", () => {
  assertEquals(isLateSave(DEST, null), false);
});

Deno.test("late save - 80% of the renamed note's text kept is a late save", () => {
  const kept = bytes("zzzzzzzzz\n".repeat(2) + "abcdefghi\n".repeat(8));
  assertEquals(isLateSave(kept, DEST), true, "8 of 10 lines = exactly 80%");
  const lost = bytes("zzzzzzzzz\n".repeat(3) + "abcdefghi\n".repeat(7));
  assertEquals(isLateSave(lost, DEST), false, "7 of 10 lines = 70%");
});

Deno.test("late save - an edit inside a line counts by its characters", () => {
  const dest = "0123456789".repeat(10);
  const edited = `abcdefghijklmno${dest.slice(15)}`;
  assertEquals(isLateSave(bytes(edited), bytes(dest)), true, "85 of 100 characters survive");
  assertEquals(isLateSave(bytes("abcdefghij".repeat(10)), bytes(dest)), false, "none survives");

  // One long line, six characters inserted mid-way: the changed line is measured by the
  // characters either side of the insert, not by fixed-width windows.
  const line = "section text the note carries. ".repeat(600);
  const inserted = `${line.slice(0, 10_000)}INSERT${line.slice(10_000)}`;
  assertEquals(isLateSave(bytes(inserted), bytes(line)), true);
});

Deno.test("late save - a CRLF save of the same note is a late save", () => {
  assertEquals(isLateSave(bytes(DEST_TEXT.replace(/\n/g, "\r\n")), DEST), true);
});

Deno.test("late save - identical text is a late save whatever the shape", () => {
  const table = "a,b,c\n".repeat(2_000);
  assertEquals(isLateSave(bytes(`\ufeff${table}`), bytes(table)), true, "BOM and repeated lines");
  assertEquals(isLateSave(bytes(table.replace(/\n/g, "\r\n")), bytes(table)), true, "a CRLF copy");
});

Deno.test("late save - a repeated-line note is a new note, not a quadratic diff", () => {
  // Both shapes would be ~100% kept if they were measured: they are new notes only
  // because the line-pair guard fires first, which is what bounds the work.
  const table = "a,b,c\n".repeat(2_000);
  assertEquals(isLateSave(bytes(`${table}extra,row,here\n`), bytes(table)), false);

  const blank = "\n".repeat(1_500);
  assertEquals(isLateSave(bytes(`${blank}x\n`), bytes(blank)), false);
});

Deno.test("late save - a large note of distinct lines is still measured", () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i} of a long note\n`).join("");
  const edited = lines.replace("line 3000 of a long note", "line 3000 of a changed note");
  assertEquals(isLateSave(bytes(edited), bytes(lines)), true);
});
