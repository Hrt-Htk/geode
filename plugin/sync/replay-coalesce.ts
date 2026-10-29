import { ServerVersion } from "../../core/protocol.ts";

export interface CoalescedEntry {
  winner: ServerVersion;
  supersededSeqs: number[];
}

// Collapse an ordered replay (receipt order) into one entry per path_hash,
// keeping the LAST version seen for each path (the only one that survives on
// disk). Winners are ordered by each path's FIRST appearance in the replay.
export function coalesceReplay(versions: ServerVersion[]): CoalescedEntry[] {
  const entries: CoalescedEntry[] = [];
  const indexByPath = new Map<string, number>();
  for (const v of versions) {
    const idx = indexByPath.get(v.path_hash);
    if (idx === undefined) {
      indexByPath.set(v.path_hash, entries.length);
      entries.push({ winner: v, supersededSeqs: [] });
    } else {
      entries[idx].supersededSeqs.push(entries[idx].winner.seq);
      entries[idx].winner = v;
    }
  }
  return entries;
}
