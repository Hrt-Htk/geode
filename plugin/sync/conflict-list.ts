// #432: the conflicts list model, obsidian-free: original-path recovery from
// the generated conflict name, type detection, kept-copy naming, path search,
// row labels. The conflict file is attributed to its creator (the device that
// made the losing edit: from the name when present, else the server head's
// device, else "Another device"); the original path to this device's copy.
// Keep mine / Keep theirs then map to the right side on BOTH the creating and
// the receiving device (on the receiver they invert).

import { b64decode } from "../../core/protocol.ts";
import { decryptMetadata, VaultKeys } from "../../core/crypto.ts";
import {
  conflictDeviceLabel,
  conflictDeviceName,
  isConflictPath,
  originalPathOf,
  splitExt,
} from "./conflicts.ts";
import type { ActivityEntry } from "./activity-log.ts";
import { isRejoinBackupPath } from "../plumbing/settings-types.ts";
import type { StateDB } from "../plumbing/state.ts";
import type { Transport } from "./transport.ts";

export type ConflictType = "note" | "image" | "pdf" | "other";

export interface ConflictSide {
  device: string;
  /** ms epoch; null when unknown. */
  time: number | null;
  /** bytes; shown for binary rows only. */
  size: number | null;
}

export interface ConflictRow {
  /** The original file path. */
  path: string;
  /** The generated conflict file. */
  conflictPath: string;
  type: ConflictType;
  /** The conflict file holds this device's own version (else it arrived from another device). */
  conflictFileIsMine: boolean;
  mine: ConflictSide;
  theirs: ConflictSide;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const REMOTE_FALLBACK = "Another device";

export function conflictType(path: string): ConflictType {
  const ext = splitExt(path).ext.toLowerCase();
  if (ext === ".md") return "note";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return "other";
}

export function typeLabel(type: ConflictType): string {
  switch (type) {
    case "note":
      return "NOTE";
    case "image":
      return "IMAGE";
    case "pdf":
      return "PDF";
    default:
      return "FILE";
  }
}

/** Keep both renames the conflict file beside the original: "a.md" → "a (kept copy).md". */
export function keptConflictPath(originalPath: string): string {
  const { stem, ext } = splitExt(originalPath);
  return `${stem} (kept copy)${ext}`;
}

/** How many open conflict files are in the vault (the same list the modal
 * shows), on any device. The single source of truth for the conflict badge. */
export function countConflictFiles(files: Array<{ path: string }>): number {
  let n = 0;
  for (const file of files) {
    // #701: a conflict copy the rejoin set aside in the backup folder is history, not
    // an open conflict: the folder never syncs and nothing acts on it.
    if (isRejoinBackupPath(file.path)) continue;
    if (isConflictPath(file.path) && originalPathOf(file.path) !== null) n++;
  }
  return n;
}

export function filterConflictRows(rows: ConflictRow[], query: string): ConflictRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.path.toLowerCase().includes(q));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ConflictRowsDeps {
  /** All user files (notes + attachments), as the debug pane's scan uses. */
  files: () => Array<{ path: string }>;
  stat: (path: string) => Promise<{ size: number; mtime: number }>;
  state: StateDB;
  keys: VaultKeys;
  transport: Transport;
  /** This device's display name. */
  deviceName: string;
  /** This device's id, for old-format conflict files without an embedded name. */
  deviceId: string;
  /** The #431 activity index: the original path's conflict entry names the remote side. */
  activity: Map<string, ActivityEntry>;
  /** deviceId→name map (fetched when the modal opens); null on failure. */
  deviceNames: Map<string, string> | null;
}

/** Whether the conflict file holds this device's own content (mine) vs another
 * device's (theirs). The embedded device name is authoritative; old-format
 * files without one fall back to the server head's device id. */
export function conflictFileIsMine(
  conflictPath: string,
  deviceName: string,
  creatorDeviceId: string | null,
  ownDeviceId: string,
): boolean {
  const fromName = conflictDeviceName(conflictPath);
  if (fromName !== null) return fromName === conflictDeviceLabel(deviceName);
  return creatorDeviceId !== null && creatorDeviceId === ownDeviceId;
}

/** One row per open conflict file found on disk. */
export async function buildConflictRows(deps: ConflictRowsDeps): Promise<ConflictRow[]> {
  const rows: ConflictRow[] = [];
  const mineName = deps.deviceName.trim() || "This device";
  for (const file of deps.files()) {
    if (isRejoinBackupPath(file.path)) continue; // #701: set aside, never an open conflict
    if (!isConflictPath(file.path)) continue;
    const path = originalPathOf(file.path);
    if (!path) continue;
    const fromName = conflictDeviceName(file.path);
    const creatorId = fromName === null ? await serverHeadDeviceId(deps, file.path) : null;
    const isMine = conflictFileIsMine(file.path, deps.deviceName, creatorId, deps.deviceId);
    const creator = fromName ?? (creatorId ? deps.deviceNames?.get(creatorId) : undefined) ??
      REMOTE_FALLBACK;
    const conflictCard = await pathSide(deps, file.path, creator);
    // The original path card names this device when it holds our copy (mine),
    // or the other device when the conflict file is ours (theirs, on the
    // creating device).
    const originalCard = await pathSide(
      deps,
      path,
      isMine ? await otherDeviceName(deps, path) : mineName,
    );
    rows.push({
      path,
      conflictPath: file.path,
      type: conflictType(path),
      conflictFileIsMine: isMine,
      mine: isMine ? conflictCard : originalCard,
      theirs: isMine ? originalCard : conflictCard,
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

/** The name of the device that authored the version at a path, for the "theirs" card. */
async function otherDeviceName(deps: ConflictRowsDeps, path: string): Promise<string> {
  const id = await serverHeadDeviceId(deps, path);
  if (id) return deps.deviceNames?.get(id) ?? REMOTE_FALLBACK;
  const entry = deps.activity.get(path);
  const deviceId = entry?.kind === "conflict" ? entry.deviceId : null;
  return (deviceId ? deps.deviceNames?.get(deviceId) : undefined) ?? REMOTE_FALLBACK;
}

/** The device that committed the path's latest version this device has seen. */
async function serverHeadDeviceId(deps: ConflictRowsDeps, path: string): Promise<string | null> {
  const row = deps.state.getLocalFile(path);
  if (!row || row.deleted) return null;
  try {
    const chain = await deps.transport.getVersionChain(row.path_hash, row.last_seen_version);
    return chain[0]?.device_id ?? null;
  } catch {
    return null;
  }
}

async function pathSide(
  deps: ConflictRowsDeps,
  path: string,
  device: string,
): Promise<ConflictSide> {
  const row = deps.state.getLocalFile(path);
  const stat = await deps.stat(path).catch(() => null);
  const serverTime = row
    ? await serverVersionTime(deps, row.path_hash, row.last_seen_version)
    : null;
  return {
    device,
    time: serverTime ?? stat?.mtime ?? null,
    size: row?.size ?? stat?.size ?? null,
  };
}

/** The mtime the remote side recorded for the version this device last saw. */
async function serverVersionTime(
  deps: ConflictRowsDeps,
  pathHash: string,
  version: number,
): Promise<number | null> {
  try {
    const chain = await deps.transport.getVersionChain(pathHash, version);
    const record = chain.find((v) => v.version === version);
    if (!record) return null;
    const meta = await decryptMetadata(b64decode(record.enc_metadata), deps.keys, pathHash);
    return meta.mtime;
  } catch {
    return null;
  }
}
