import { log } from "./log.ts";
import { getCurrentHeadVersion, insertVersion } from "./db.ts";
import {
  deleteTrashedHead,
  getTrashedContent,
  getTrashedHead,
  headCap,
  listTrash,
  nameMovedOn,
  purgeAllTrash,
  purgeExpiredTrash,
} from "./trash-db.ts";
import { type ChainEntry, eraseHistory } from "./trash-erase.ts";
import { adminGate, jsonResp, readJson, rekeyBlock, requireDevice } from "./http-helpers.ts";
import { parseBearerHeader, validateAdminToken } from "./auth.ts";
import type { Database } from "@db/sqlite";
import { b64decode } from "../core/protocol.ts";
import { broadcastVersionIfLive } from "./ws.ts";
import { TRASH_RETENTION_DAYS } from "./compaction.ts";
import { addVaultBytes, rowBytes, vaultOverBudget } from "./vault-budget.ts";

// `insertVersion`'s two trailing flags are both integers, so a bare `0, 1` is one typo
// away from `(0, 0)`: a restore recorded as an ordinary version, silently (#687).
const NO_RENAME_MARK = 0;
const RESTORED_MARK = 1;

// Shared restore logic: returns ok or conflict indicator. #687: the restored version
// is credited to the device that asked for it and marked restored, so that device
// applies it like any remote version instead of skipping its own.
// #679: a restore writes a version row, so a vault past its budget refuses it.
function restoreEntry(
  db: Database,
  vaultId: string,
  pathHash: string,
  deviceId: string,
): { ok: true; version: number; seq: number } | { conflict: true } | { full: true } {
  if (vaultOverBudget(db, vaultId)) return { full: true };
  const trashed = getTrashedHead(db, vaultId, pathHash);
  if (!trashed) return { conflict: true };

  const headParsed = JSON.parse(trashed.head_json) as {
    version: number;
    parent: number | null;
    chunk_hashes: string[];
    enc_metadata: string;
    path_ciphertext?: string | null;
    deleted: number;
  };
  const encMetadataBytes = b64decode(headParsed.enc_metadata);
  const chunkHashes = headParsed.chunk_hashes;
  const pathCiphertext = headParsed.path_ciphertext ? b64decode(headParsed.path_ciphertext) : null;
  const currentHead = getCurrentHeadVersion(db, vaultId, pathHash) ?? 0;
  // #583 §13 / #596: the name moved on: later content means a different file owns it
  // (restoring would revert that file), a later marker means a rename closed it
  // (restoring would resurrect a renamed-away name). Refuse either way.
  if (nameMovedOn(db, vaultId, pathHash, headParsed.version)) return { conflict: true };

  const result = insertVersion(
    db,
    vaultId,
    pathHash,
    currentHead,
    encMetadataBytes,
    chunkHashes,
    false,
    deviceId,
    pathCiphertext,
    NO_RENAME_MARK,
    RESTORED_MARK,
  );

  if ("conflict" in result) return { conflict: true };

  addVaultBytes(db, vaultId, rowBytes(encMetadataBytes, pathCiphertext, chunkHashes));
  deleteTrashedHead(db, vaultId, pathHash);

  broadcastVersionIfLive(vaultId, {
    version: result.version,
    parent: currentHead,
    seq: result.seq,
    path_hash: pathHash,
    enc_metadata: encMetadataBytes,
    chunk_hashes: JSON.stringify(chunkHashes),
    deleted: 0,
    device_id: deviceId,
    created_at: Date.now(),
    compacted_range: null,
    path_ciphertext: pathCiphertext,
    rename_mark: NO_RENAME_MARK,
    restored: RESTORED_MARK,
  });

  return { ok: true, version: result.version, seq: result.seq };
}

export function handleListTrash(db: Database, vaultId: string, req: Request): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;

  const trash = listTrash(db, vaultId);
  log.info("trash list", { vault_id: vaultId, count: trash.length });
  // Additive: the server's retention floor, so the client's expiry display
  // matches the real purge cutoff (its own setting may be lower).
  return jsonResp({ trash, retention_days: TRASH_RETENTION_DAYS }, 200);
}

// #455: the deleted file's encrypted content record (chunk IDs + FileMeta). The
// client fetches the blobs and decrypts to this device only; the server never
// sees plaintext. Returns 404 when the path isn't in this vault's trash.
export function handleTrashContent(
  db: Database,
  vaultId: string,
  pathHash: string,
  req: Request,
): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;

  const content = getTrashedContent(db, vaultId, pathHash);
  if (!content) return jsonResp({ error: "not in trash" }, 404);

  log.info("trash content", { vault_id: vaultId, path_hash: pathHash });
  return jsonResp(content, 200);
}

export function handleRestoreOne(
  db: Database,
  vaultId: string,
  pathHash: string,
  req: Request,
): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;
  const blocked = rekeyBlock(db, vaultId);
  if (blocked) return blocked;

  const trashed = getTrashedHead(db, vaultId, pathHash);
  if (!trashed) return jsonResp({ error: "not in trash" }, 404);

  const result = restoreEntry(db, vaultId, pathHash, authResult.device_id);
  if ("full" in result) return jsonResp({ error: "vault storage full" }, 507);
  if ("conflict" in result) return jsonResp({ error: "restore conflict, retry" }, 409);

  log.info("trash restore one", { vault_id: vaultId, path_hash: pathHash });
  return jsonResp({ restored: true, version: result.version, seq: result.seq }, 200);
}

export function handleRestoreAll(db: Database, vaultId: string, req: Request): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;
  const blocked = rekeyBlock(db, vaultId);
  if (blocked) return blocked;

  const entries = listTrash(db, vaultId);
  let restored = 0;
  let skipped = 0;
  for (const entry of entries) {
    const result = restoreEntry(db, vaultId, entry.path_hash, authResult.device_id);
    if ("ok" in result) {
      restored++;
    } else {
      skipped++;
    }
  }

  log.info("trash restore all", { vault_id: vaultId, restored, skipped });
  return jsonResp({ restored, skipped }, 200);
}

// #582: the names a file lived at, with the version ceiling of each (the client's
// History walk). Absent on an old plugin: the row's own generation still goes. The
// root entry is the server's to derive, so a client entry for it is dropped.
const MAX_CHAIN = 32;

/** One wire entry, or null when it is not a name + a positive version. */
function toChainEntry(raw: unknown): ChainEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { path_hash: pathHash, up_to: upTo } = raw as Record<string, unknown>;
  if (typeof pathHash !== "string" || pathHash.length === 0) return null;
  if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 1) return null;
  return { pathHash, upTo, link: true };
}

function parseChain(body: { chain?: unknown } | null, rootPathHash: string): ChainEntry[] | null {
  if (body?.chain === undefined) return [];
  if (!Array.isArray(body.chain)) return null;
  const seen = new Set<string>();
  const chain: ChainEntry[] = [];
  for (const wireEntry of body.chain) {
    const entry = toChainEntry(wireEntry);
    if (!entry) return null;
    if (entry.pathHash === rootPathHash) continue;
    const key = `${entry.pathHash}:${entry.upTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(entry);
  }
  return chain.length > MAX_CHAIN ? null : chain;
}

/** #677: the cutoff purge-expired uses (#532): a row older than the server's own
 * retention floor is one the server would drop itself, so a device token may purge it. */
function pastFloor(trashedAt: number): boolean {
  return trashedAt < Math.floor(Date.now() / 1000) - TRASH_RETENTION_DAYS * 86400;
}

/** #677: a purge deletes content versions, not just a trash row, so a device token may
 * only reach a row the server would purge by itself; the admin token is root and may purge
 * any row. A bearer that is neither is an admin-token guess and is charged through
 * adminGate: uncharged, this route is a free oracle. */
function authorizePurge(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): { admin: boolean } | Response {
  const bearer = parseBearerHeader(req.headers.get("authorization"));
  if (bearer !== null && validateAdminToken(bearer, adminToken)) {
    return adminGate(req, adminToken) ?? { admin: true }; // per-IP rate limit + success recording
  }
  const device = requireDevice(db, req, vaultId);
  if (!(device instanceof Response)) return { admin: false };
  // A request with no bearer is not a guess, and a device purge never fails here, so
  // neither is ever throttled.
  return bearer === null ? device : adminGate(req, adminToken) ?? device;
}

export async function handlePurgeOne(
  db: Database,
  vaultId: string,
  pathHash: string,
  req: Request,
  adminToken: string | null,
): Promise<Response> {
  const auth = authorizePurge(db, vaultId, req, adminToken);
  if (auth instanceof Response) return auth;
  const blocked = rekeyBlock(db, vaultId);
  if (blocked) return blocked;

  const trashed = getTrashedHead(db, vaultId, pathHash);
  // An old client's DELETE keeps its old answer for a row that is already gone.
  if (!trashed) {
    return req.method === "DELETE"
      ? jsonResp({ purged: false }, 200)
      : jsonResp({ error: "not in trash" }, 404);
  }
  if (!auth.admin && !pastFloor(trashed.trashed_at)) {
    log.info("trash purge refused", {
      vault_id: vaultId,
      path_hash: pathHash,
      reason: "retention_floor",
    });
    return jsonResp({ error: "purge_requires_admin" }, 403);
  }
  const body = await readJson<{ chain?: unknown }>(req);
  if (body instanceof Response) return body;
  const chain = parseChain(body, pathHash);
  if (chain === null) return jsonResp({ error: "bad chain" }, 400);

  // The row's own name always goes, up to the version it was deleted at; the chain
  // the client walked adds every earlier name.
  const erase = eraseHistory(
    db,
    vaultId,
    [{ pathHash, upTo: headCap(trashed.head_json), link: false }, ...chain],
    pathHash,
  );
  if (!erase.ok) {
    log.info("trash purge refused", {
      vault_id: vaultId,
      path_hash: pathHash,
      reason: erase.error,
    });
    return jsonResp({ error: erase.error }, erase.error === "live_head" ? 409 : 400);
  }

  log.info("trash purge one", {
    vault_id: vaultId,
    path_hash: pathHash,
    versions: erase.versions,
  });
  return jsonResp({ purged: true, versions: erase.versions }, 200);
}

export async function handlePurgeExpired(
  db: Database,
  vaultId: string,
  req: Request,
): Promise<Response> {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;
  const blocked = rekeyBlock(db, vaultId);
  if (blocked) return blocked;

  // #532: the client value may only extend retention, never shorten it: a
  // stolen device token must not be able to purge trash younger than the
  // server's own retention window.
  let retentionDays = TRASH_RETENTION_DAYS;
  const body = await readJson<{ retention_days?: number }>(req);
  if (body instanceof Response) return body;
  if (typeof body?.retention_days === "number") {
    retentionDays = Math.max(TRASH_RETENTION_DAYS, body.retention_days);
  }

  const count = purgeExpiredTrash(db, retentionDays * 24 * 3600, vaultId);
  log.info("trash purge expired", {
    vault_id: vaultId,
    purged: count,
    retention_days: retentionDays,
  });
  return jsonResp({ purged: count }, 200);
}

export function handlePurgeAll(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Response {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;
  const blocked = rekeyBlock(db, vaultId);
  if (blocked) return blocked;

  const count = purgeAllTrash(db, vaultId);

  log.info("trash purge all", { vault_id: vaultId, purged: count });
  return jsonResp({ purged: count }, 200);
}
