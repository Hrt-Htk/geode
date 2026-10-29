/** Pure last-backup stamp gate: no obsidian import (safe for deno unit tests). */
export function shouldStampBackup(i: {
  live: boolean;
  dirty: number;
  pending: number;
  dropped: number;
}): boolean {
  return i.live && i.dirty === 0 && i.pending === 0 && i.dropped === 0;
}
