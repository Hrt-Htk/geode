// #53: a device that ran a re-key restarts with rows under the old path hashes: edits heal
// their own row, but a delete or rename-away sends the old hash and the server never finds
// it. Runs before the reconciler reads the rows. One reason to change: that repair.

import { hashPathHex } from "../../core/hash.ts";
import { log } from "../plumbing/log.ts";
import type { LocalFileRow } from "../plumbing/state.ts";

export interface StaleRowPlan {
  /** Rows to rewrite under the current hash. */
  corrected: LocalFileRow[];
  /** Live rows whose file is gone: the delete was made under the old hash and never
   * landed, so the file comes back. The download rewrites the row: one that fails stays
   * stale, so its delete cannot land on the retry either. */
  restore: string[];
}

export async function planStaleRows(
  rows: Iterable<LocalFileRow>,
  macKey: Uint8Array,
  exists: (path: string) => Promise<boolean>,
  isSyncable: (path: string) => boolean,
): Promise<StaleRowPlan> {
  const plan: StaleRowPlan = { corrected: [], restore: [] };
  for (const row of rows) {
    const pathHash = hashPathHex(macKey, row.path);
    if (row.path_hash === pathHash) continue;
    if (!row.deleted && isSyncable(row.path) && !await exists(row.path)) {
      plan.restore.push(row.path);
    } else {
      plan.corrected.push({ ...row, path_hash: pathHash });
    }
  }
  return plan;
}

export async function healStaleRows(deps: {
  rows: Iterable<LocalFileRow>;
  macKey: Uint8Array;
  exists: (path: string) => Promise<boolean>;
  isSyncable: (path: string) => boolean;
  upsert: (row: LocalFileRow) => void;
  restore: (paths: string[]) => Promise<void>;
}): Promise<void> {
  const plan = await planStaleRows(deps.rows, deps.macKey, deps.exists, deps.isSyncable);
  if (plan.corrected.length === 0 && plan.restore.length === 0) return;
  log.info("repairing stale path hashes", {
    corrected: plan.corrected.length,
    restore: plan.restore,
  });
  for (const row of plan.corrected) deps.upsert(row);
  if (plan.restore.length === 0) return;
  try {
    await deps.restore(plan.restore);
  } catch (error) {
    log.warn("stale row restore failed, retrying at the next connection", {
      error: String(error),
    });
  }
}
