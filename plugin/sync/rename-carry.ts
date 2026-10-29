// #583: a local edit whose name the server closed as a rename: it follows the note
// to the new name, or is kept next to it, and the renamed-away name is always left
// empty (never resurrected).

import { RENAME_MARKER } from "../../core/protocol.ts";
import { VaultKeys } from "../../core/crypto.ts";
import { hashPathHex } from "../../core/hash.ts";
import { StateDB } from "../plumbing/state.ts";
import { log } from "../plumbing/log.ts";
import { generateConflictPath } from "./conflicts.ts";
import {
  readVaultBinary,
  removeVaultPath,
  renameableFile,
  renameVaultFile,
  type Vault,
  writeVaultBinary,
} from "./vault-io.ts";

export type RenameCarry =
  | { kind: "none" }
  | { kind: "moved"; to: string }
  | { kind: "kept"; conflictPath: string };

type RenameCarryDeps = {
  vault: Vault;
  state: StateDB;
  keys: VaultKeys;
  suppressSelfWrite: (path: string) => void;
  /** #697: mark this device's own applied rename as the (old, new) pair; the returned
   * function clears the mark when the rename did not happen. */
  suppressSelfRename?: (from: string, to: string) => () => void;
  deviceName?: string;
  renameHeadOf?: (
    pathHash: string,
  ) => Promise<{ version: number; deleted: number; rename_mark?: number } | null>;
  /** A rename-away of `path` this device has queued or still holds in the event
   * debounce: its row may already be gone and no marker is on the server yet, so
   * the name is being closed here: it is taken (#595). */
  pendingRenameTarget: (path: string) => string | undefined;
};

/** #583 (decision 2): carry this device's uncommitted edit from a path the server
 * closed as a rename to the name its marker points at. A taken destination keeps both:
 * the destination holds its own bytes, the edit goes to a sibling conflict file, and
 * the renamed-away name is always left empty (never resurrected). */
export async function carryLocalEdit(
  closed: { path: string; renamedTo?: string; pendingEdit: boolean },
  deps: RenameCarryDeps,
): Promise<RenameCarry> {
  if (!closed.pendingEdit || !closed.renamedTo) return { kind: "none" };
  const { path: from, renamedTo: to } = closed;
  const body = await readVaultBinary(from, deps.vault);
  if (body === null) return { kind: "none" };
  if (await destinationTaken(to, deps)) return await keepNextToDestination(from, to, body, deps);
  await moveNextToDestination(from, to, body, deps);
  return { kind: "moved", to };
}

/** Is the destination held by something else (a name this device is renaming away, a
 * live row, a file, or a name the server renamed away again)? */
async function destinationTaken(to: string, deps: RenameCarryDeps): Promise<boolean> {
  // This device is closing the name right now: writing the edit there re-creates it.
  if (deps.pendingRenameTarget(to) !== undefined) return true;
  const row = deps.state.getLocalFile(to);
  if (row !== null && !row.deleted) return true;
  if (row?.deleted === true && !await closedDestinationIsFree(to, deps)) return true;
  return await readVaultBinary(to, deps.vault) !== null;
}

/** Keep both: the destination row is left alone (its version and hash stay valid) and
 * the edit lands in a sibling conflict file, which syncs as an ordinary new file. */
async function keepNextToDestination(
  from: string,
  to: string,
  body: Uint8Array,
  deps: RenameCarryDeps,
): Promise<RenameCarry> {
  const conflictPath = await freeConflictPath(to, deps);
  const renamed = await moveByRename(from, conflictPath, deps);
  // A rename fires no create: writing the bytes at the sibling is what makes its modify
  // event commit it. Read them back first, so an autosave since the rename is not reverted.
  const bytes = (renamed ? await readVaultBinary(conflictPath, deps.vault) : null) ?? body;
  await writeVaultBinary(conflictPath, bytes, Date.now(), deps.vault);
  if (!renamed) await dropOldName(from, to, deps);
  log.info("renamed-away edit kept next to the new name", { from, to, conflictPath });
  return { kind: "kept", conflictPath };
}

/** The bytes move to the destination as a local edit with no version of its own. */
async function moveNextToDestination(
  from: string,
  to: string,
  body: Uint8Array,
  deps: RenameCarryDeps,
): Promise<void> {
  if (!await moveByRename(from, to, deps)) {
    deps.suppressSelfWrite(to);
    await writeVaultBinary(
      to,
      body,
      deps.state.getLocalFile(from)?.mtime ?? Date.now(),
      deps.vault,
    );
    await dropOldName(from, to, deps);
  }
  await recordMovedAt(from, to, deps);
  log.info("local edit follows rename", { from, to });
}

/** #697: the note only leaves its name (no pending edit moves with it): the file itself
 * follows by a real vault rename, so an editor open on it survives the old name closing
 * (#695). False = the destination is taken or this vault cannot rename it; the caller
 * then closes the old name as before. */
export async function followRename(
  from: string,
  to: string,
  deps: RenameCarryDeps,
): Promise<boolean> {
  if (await destinationTaken(to, deps)) return false;
  if (!await moveByRename(from, to, deps)) return false;
  // The destination stays tracked while the note is in flight: an untracked file would be
  // reconciled as a new one, and a second marker for that name must read it as taken. The
  // reconciler leaves this row alone until the note's version lands.
  await recordMovedAt(from, to, deps);
  log.info("file follows the rename", { from, to });
  return true;
}

/** #697: move the file with the vault's own rename where it can: Obsidian takes an open
 * editor with it, where write + remove tears it down with the old name (#695). */
async function moveByRename(
  from: string,
  to: string,
  deps: RenameCarryDeps,
): Promise<boolean> {
  const file = renameableFile(from, deps.vault);
  if (file === null) return false;
  const release = deps.suppressSelfRename?.(from, to);
  const renamed = await renameVaultFile(file, to, deps.vault);
  if (!renamed) release?.();
  return renamed;
}

/** The moved bytes are a local edit with no version of this path yet: the row carries the
 * hash the edit was made against, so the note's merge compares bases instead of trusting
 * a moved version. */
async function recordMovedAt(from: string, to: string, deps: RenameCarryDeps): Promise<void> {
  const source = deps.state.getLocalFile(from);
  const stat = await Promise.resolve().then(() => deps.vault.adapter.stat?.(to)).catch(() => null);
  deps.state.upsertLocalFile({
    path: to,
    path_hash: hashPathHex(deps.keys.mac_key, to),
    size: stat?.size ?? source?.size ?? 0,
    mtime: stat?.mtime ?? source?.mtime ?? Date.now(),
    plaintext_hash: source?.plaintext_hash ?? "",
    last_seen_version: 0,
    chunk_hashes: source?.chunk_hashes ?? [],
  });
}

/** A closed destination row is a free recycled name only when the server holds no
 * rename marker on it: a marker means the name was renamed away again, and writing
 * there would walk a rename cycle forever. */
async function closedDestinationIsFree(path: string, deps: RenameCarryDeps): Promise<boolean> {
  if (!deps.renameHeadOf) return false;
  const head = await deps.renameHeadOf(hashPathHex(deps.keys.mac_key, path));
  return head === null || head.rename_mark !== RENAME_MARKER;
}

/** The first free "(conflict …)" name next to `path`. */
export async function freeConflictPath(
  path: string,
  deps: { vault: Vault; deviceName?: string },
): Promise<string> {
  const ts = new Date();
  for (let n = 0;; n++) {
    const candidate = generateConflictPath(path, deps.deviceName ?? "", ts, n);
    if (await readVaultBinary(candidate, deps.vault) === null) return candidate;
  }
}

/** Drop the renamed-away name. A case-only rename is one inode on a case-insensitive
 * filesystem, so there the removal is verified and the bytes are put back at the new
 * spelling if it went with it. */
async function dropOldName(from: string, to: string, deps: RenameCarryDeps): Promise<void> {
  if (isCaseOnlyPath(from, to)) return await dropOldSpelling(from, to, deps);
  deps.suppressSelfWrite(from);
  await removeVaultPath(from, deps.vault);
}

/** Drop the old spelling of a rename that only changes case, without ever taking the
 * new spelling with it: on a case-insensitive filesystem both names are one inode, so
 * the removal is verified and the bytes are put back at the new spelling if it went. */
export async function dropOldSpelling(
  from: string,
  to: string,
  deps: { vault: Vault; suppressSelfWrite: (path: string) => void },
): Promise<void> {
  if (await readVaultBinary(from, deps.vault) === null) return;
  const keep = await readVaultBinary(to, deps.vault);
  deps.suppressSelfWrite(from);
  await removeVaultPath(from, deps.vault);
  if (keep === null || await readVaultBinary(to, deps.vault) !== null) return;
  deps.suppressSelfWrite(to);
  await writeVaultBinary(to, keep, Date.now(), deps.vault);
}

function isCaseOnlyPath(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase();
}
