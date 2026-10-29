import type { Database } from "@db/sqlite";
import { RENAME_NOTE } from "../core/protocol.ts";

// ── #582: erase one file's history (Delete forever, and every purge path) ──────
// A name's generations are delimited by rename markers and notes, so the newest one
// below a ceiling is where this file starts: a reused name keeps the other file's
// saves. The client supplies the ceilings (its History walk's chain); the server
// re-derives the start itself, refuses a cap that is not a boundary, and never
// erases a name's head: a name left with no rows breaks its version order for good.

/** One name of a file's chain: every version up to `upTo` is this file's. `link` is a
 * name the client walked to, whose cap must be a rename marker or note; the root's cap
 * is the trashed head, which the server read. */
export interface ChainEntry {
  pathHash: string;
  upTo: number;
  link: boolean;
}

export type EraseError = "unknown_path_hash" | "unknown_ceiling" | "not_a_boundary" | "live_head";

export type EraseOutcome = { ok: true; versions: number } | { ok: false; error: EraseError };

interface NameHead {
  version: number;
  deleted: number;
}

function nameHead(db: Database, vaultId: string, pathHash: string): NameHead | null {
  return db.prepare(
    `SELECT version, deleted FROM file_versions
     WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1`,
  ).get(vaultId, pathHash) as NameHead | null;
}

/** The rename mark at `version`, or null when the name has no such row. */
function markAt(db: Database, vaultId: string, pathHash: string, version: number): number | null {
  const row = db.prepare(
    `SELECT rename_mark FROM file_versions
     WHERE vault_id = ? AND path_hash = ? AND version = ?`,
  ).get(vaultId, pathHash, version) as { rename_mark: number } | null;
  return row ? row.rename_mark : null;
}

/** The first version of this name's own generation, at or below `cap`: a marker
 * closed the previous one, a note opened this one. */
function generationStart(
  db: Database,
  vaultId: string,
  pathHash: string,
  cap: number,
): number {
  const boundary = db.prepare(
    `SELECT version, rename_mark FROM file_versions
     WHERE vault_id = ? AND path_hash = ? AND version < ? AND rename_mark != 0
     ORDER BY version DESC LIMIT 1`,
  ).get(vaultId, pathHash, cap) as { version: number; rename_mark: number } | null;
  if (!boundary) return 1;
  return boundary.rename_mark === RENAME_NOTE ? boundary.version : boundary.version + 1;
}

/** A walked cap must be a boundary: a rename marker or note. The server cannot prove
 * the chain belongs to the file, but a cap that is not a boundary could sit inside a
 * live file's saves: refused. */
function boundaryError(
  db: Database,
  vaultId: string,
  pathHash: string,
  upTo: number,
): EraseError | null {
  const mark = markAt(db, vaultId, pathHash, upTo);
  if (mark === null) return "unknown_ceiling";
  return mark === 0 ? "not_a_boundary" : null;
}

/**
 * Delete every version this file owns at every name in `chain`, plus its trash row.
 * All-or-nothing: every entry is validated before a row is touched, so a refused
 * erase never half-erases. A live head (the name is content again at or below the
 * ceiling) is refused, and every name keeps its head row, so a later create on it
 * continues at head + 1.
 */
export function eraseHistory(
  db: Database,
  vaultId: string,
  chain: ChainEntry[],
  trashPath: string | null,
): EraseOutcome {
  const plans: Array<{ pathHash: string; from: number; to: number }> = [];
  for (const entry of chain) {
    const head = nameHead(db, vaultId, entry.pathHash);
    if (!head) return { ok: false, error: "unknown_path_hash" };
    const boundary = entry.link ? boundaryError(db, vaultId, entry.pathHash, entry.upTo) : null;
    if (boundary) return { ok: false, error: boundary };
    if (head.deleted === 0 && head.version <= entry.upTo) return { ok: false, error: "live_head" };
    plans.push({
      pathHash: entry.pathHash,
      from: generationStart(db, vaultId, entry.pathHash, entry.upTo),
      to: Math.min(entry.upTo, head.version - 1),
    });
  }

  const versions = db.transaction(() => {
    let deleted = 0;
    for (const plan of plans) {
      if (plan.from > plan.to) continue;
      deleted += db.prepare(
        `DELETE FROM file_versions
         WHERE vault_id = ? AND path_hash = ? AND version >= ? AND version <= ?`,
      ).run(vaultId, plan.pathHash, plan.from, plan.to);
    }
    if (trashPath !== null) {
      db.prepare("DELETE FROM trashed_heads WHERE vault_id = ? AND path_hash = ?")
        .run(vaultId, trashPath);
    }
    return deleted;
  })();

  return { ok: true, versions };
}
