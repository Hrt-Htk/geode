// #695: a file that turns up at a name a peer renamed away: is it that note's late
// save, or a new note that merely reused the free name?

import { diffIndices } from "node-diff3";
import { normalizeMarkdownLineEndings, stripBOM } from "../../core/normalize.ts";

const decoder = new TextDecoder();

/** Both sides are read and compared inside the path lock, so past this size the answer
 * is "new note" instead of a measure no user would wait for. */
const MAX_BYTES = 256 * 1024;
/** The line LCS costs one step per pair of equal lines: repeated lines (blank lines, a
 * copied table) make it quadratic, so a heavily repeated file is a new note too. */
const MAX_LINE_MATCHES = 100_000;
/** #695: the share of the renamed note's text a late save still holds. */
const LATE_SAVE_RATIO = 0.8;

/** #695: the file at the closed name is the renamed note's own late save only when its
 * content is that note's text: `dest` is the marker's target, read from this device's
 * disk, and 80% of it must still be in the file. Anything else: an empty file, another
 * note that reused the free name, an attachment: is a new file and stays put. */
export function isLateSave(file: Uint8Array, dest: Uint8Array | null): boolean {
  if (dest === null) return false;
  if (file.length > MAX_BYTES || dest.length > MAX_BYTES) return false;
  const text = markdownText(file);
  if (!text.trim()) return false;
  const want = markdownText(dest);
  if (text === want) return true;
  return want.length > 0 && keptChars(want, text) / want.length >= LATE_SAVE_RATIO;
}

/** The text as the rest of the pipeline hashes it: BOM and line endings normalized, so a
 * CRLF save of the same note is not one giant changed line. */
function markdownText(bytes: Uint8Array): string {
  return normalizeMarkdownLineEndings(stripBOM(decoder.decode(bytes)));
}

/** Characters of the renamed note that survive in the file: lines both sides share count
 * their own length, and each changed run between them counts only what its two texts
 * share at the head and at the tail. Exact for the one-region edit a save makes, linear
 * for any run: a changed run never costs a diff of its own. */
function keptChars(want: string, have: string): number {
  const wantLines = want.split("\n");
  const haveLines = have.split("\n");
  if (lineMatches(wantLines, haveLines) > MAX_LINE_MATCHES) return 0;
  let kept = 0;
  let at = 0;
  for (const hunk of diffIndices(wantLines, haveLines)) {
    const [start, length] = hunk.buffer1 as [number, number];
    for (let i = at; i < start; i++) kept += lineChars(wantLines, i);
    kept += changedChars(hunk.buffer1Content, hunk.buffer2Content);
    at = start + length;
  }
  for (let i = at; i < wantLines.length; i++) kept += lineChars(wantLines, i);
  return kept;
}

/** A line's characters plus the newline that ends it: none after the last line. */
function lineChars(lines: string[], i: number): number {
  return lines[i].length + (i < lines.length - 1 ? 1 : 0);
}

/** The steps an LCS would take, one per pair of equal lines. Built in one pass, before
 * any diff runs. */
function lineMatches(want: string[], have: string[]): number {
  const counts = new Map<string, number>();
  for (const line of want) counts.set(line, (counts.get(line) ?? 0) + 1);
  let pairs = 0;
  for (const line of have) pairs += counts.get(line) ?? 0;
  return pairs;
}

/** A changed run of lines: the characters its two texts share at the head and tail. */
function changedChars(want: string[], have: string[]): number {
  const a = want.join("\n");
  const b = have.join("\n");
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return head + tail;
}
