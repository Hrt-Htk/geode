// #435: the one line alignment behind both diff surfaces: the history pane's
// Changes view and the conflict review's version comparison. node-diff3's LCS
// does the work (the merger's own dependency), so there is no second algorithm;
// lines keep their plain text and carry which side of the diff they came from.

import { diffIndices } from "node-diff3";

export type SourceLine = { kind: "same" | "before" | "after"; text: string };

/** `before` lines only in the first text, `after` lines only in the second, in
 * file order: a spot both texts changed arrives as one `before` then its
 * `after`, so the caller can stack the two variants. */
export function alignLines(beforeText: string, afterText: string): SourceLine[] {
  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const lines: SourceLine[] = [];
  let at = 0;
  for (const hunk of diffIndices(before, after)) {
    const [start, removed] = hunk.buffer1;
    while (at < start) lines.push({ kind: "same", text: before[at++] });
    for (const text of hunk.buffer1Content) lines.push({ kind: "before", text });
    for (const text of hunk.buffer2Content) lines.push({ kind: "after", text });
    at = start + removed;
  }
  while (at < before.length) lines.push({ kind: "same", text: before[at++] });
  return lines;
}
