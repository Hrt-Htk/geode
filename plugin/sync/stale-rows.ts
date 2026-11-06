// #53: which rows predate a re-key on this device, and what each needs.

import { hashPathHex } from "../../core/hash.ts";
import type { LocalFileRow } from "../plumbing/state.ts";

export async function planStaleRows(
  rows: Iterable<LocalFileRow>,
  macKey: Uint8Array,
  exists: (path: string) => Promise<boolean>,
  isSyncable: (path: string) => boolean,
): Promise<{ corrected: string[]; restore: string[] }> {
  const plan: { corrected: string[]; restore: string[] } = { corrected: [], restore: [] };
  for (const row of rows) {
    if (row.path_hash === hashPathHex(macKey, row.path)) continue;
    const gone = !row.deleted && isSyncable(row.path) && !await exists(row.path);
    (gone ? plan.restore : plan.corrected).push(row.path);
  }
  return plan;
}
