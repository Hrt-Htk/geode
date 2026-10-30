import { adminGate, jsonResp, readJson, requireDevice } from "./http-helpers.ts";
import { disconnectDeviceIfLive } from "./ws.ts";
import { log } from "./log.ts";
import type { Database } from "@db/sqlite";

export function handleListVaults(
  db: Database,
  req: Request,
  adminToken: string | null,
): Response {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;

  const rows = db.prepare(
    `SELECT v.id, v.name, CAST(v.created_at AS REAL) AS created_at,
            COUNT(d.id) AS device_count,
            COALESCE(MAX(d.last_seen_at), 0) AS last_seen_at,
            GROUP_CONCAT(DISTINCT d.plugin_version) AS plugin_versions
     FROM vaults v LEFT JOIN devices d
       ON d.vault_id = v.id AND d.token NOT LIKE 'revoked:%' AND d.is_restore = 0
     WHERE v.rekey_of IS NULL
     GROUP BY v.id`,
  ).all() as Array<{
    id: string;
    name: string;
    created_at: number;
    device_count: number;
    last_seen_at: number;
    plugin_versions: string;
  }>;

  return jsonResp(rows, 200);
}

export function handleListDevices(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Response {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;

  const rows = db.prepare(
    "SELECT id, name, last_seen_at, COALESCE(plugin_version, '') AS plugin_version FROM devices WHERE vault_id = ? AND token NOT LIKE 'revoked:%' AND is_restore = 0",
  ).all(vaultId) as Array<{
    id: string;
    name: string;
    last_seen_at: number;
    plugin_version: string;
  }>;

  return jsonResp(rows, 200);
}

// Device-token list for the Devices view (#433): per-device applied position +
// the vault head so the client can render "N changes behind". Vault-scoped via
// requireDevice; admin routes stay unchanged.
export function handleListDeviceStatus(
  db: Database,
  vaultId: string,
  req: Request,
): Response {
  const info = requireDevice(db, req, vaultId);
  if (info instanceof Response) return info;

  const head = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS m FROM file_versions WHERE vault_id = ?",
  ).get(vaultId) as { m: number };
  const rows = db.prepare(
    "SELECT id, name, last_seen_at, applied_seq FROM devices WHERE vault_id = ? AND token NOT LIKE 'revoked:%' AND is_restore = 0",
  ).all(vaultId) as Array<{
    id: string;
    name: string;
    last_seen_at: number;
    applied_seq: number | null;
  }>;

  return jsonResp({ head_seq: head.m, devices: rows }, 200);
}

export function handleRevokeDevice(
  db: Database,
  vaultId: string,
  deviceId: string,
  req: Request,
  adminToken: string | null,
): Response {
  // 1. Admin auth (unchanged)
  const denied = adminGate(req, adminToken);
  if (!denied) {
    return doRevoke(db, vaultId, deviceId);
  }

  // 2. Device-token self-revoke: device may delete ONLY its own row
  const info = requireDevice(db, req, vaultId);
  if (info instanceof Response) return info;
  if (info.device_id !== deviceId) {
    return jsonResp({ error: "forbidden" }, 403);
  }

  return doRevoke(db, vaultId, deviceId);
}

export async function handleRenameDevice(
  db: Database,
  vaultId: string,
  deviceId: string,
  req: Request,
): Promise<Response> {
  // Device-token only, self-only: no admin path (mirrors handlePutVerifier's gate).
  const info = requireDevice(db, req, vaultId);
  if (info instanceof Response) return info;
  if (info.device_id !== deviceId) {
    return jsonResp({ error: "forbidden" }, 403);
  }

  const body = await readJson<{ name?: string }>(req);
  if (body instanceof Response) return body;
  const name = body?.name?.trim();
  if (!name || name.length > 64) {
    return jsonResp({ error: "invalid name" }, 400);
  }

  const existing = db.prepare(
    "SELECT is_restore FROM devices WHERE id = ? AND vault_id = ?",
  ).get(deviceId, vaultId) as { is_restore: number } | null;
  if (!existing) {
    return jsonResp({ error: "device not found" }, 404);
  }
  if (existing.is_restore === 1) return retiredDevice();

  db.run(
    "UPDATE devices SET name = ? WHERE id = ? AND vault_id = ?",
    name,
    deviceId,
    vaultId,
  );

  log.info("device renamed", { device_id: deviceId, vault_id: vaultId });

  return jsonResp({ ok: true }, 200);
}

export async function handleRenameVault(
  db: Database,
  vaultId: string,
  req: Request,
): Promise<Response> {
  // Device-token only: no admin path (the settings panel has no admin token).
  // Any device of the vault may rename the vault; no per-device restriction.
  const info = requireDevice(db, req, vaultId);
  if (info instanceof Response) return info;

  const body = await readJson<{ name?: string }>(req);
  if (body instanceof Response) return body;
  const name = body?.name?.trim();
  if (!name || name.length > 64) {
    return jsonResp({ error: "invalid name" }, 400);
  }

  // No 404 branch: a valid device token FK-references an existing vault, and the
  // vault_id gate above pins it: the vault cannot be absent here (no delete endpoint).
  db.run(
    "UPDATE vaults SET name = ? WHERE id = ?",
    name,
    vaultId,
  );

  log.info("vault renamed", { vault_id: vaultId });

  return jsonResp({ ok: true }, 200);
}

/** #687: the retired restore pseudo device (migration 016 flags it) is not a device
 * the user has: it stays out of every list and count, and cannot be renamed or
 * revoked. Its row survives because the versions it authored reference it. */
function retiredDevice(): Response {
  return jsonResp({ error: "not a device" }, 403);
}

function doRevoke(
  db: Database,
  vaultId: string,
  deviceId: string,
): Response {
  const existing = db.prepare(
    "SELECT is_restore FROM devices WHERE id = ? AND vault_id = ?",
  ).get(deviceId, vaultId) as { is_restore: number } | null;

  if (!existing) {
    return jsonResp({ error: "device not found" }, 404);
  }
  if (existing.is_restore === 1) return retiredDevice();

  // Soft-revoke: set a unique revoked token so it won't match any real token.
  // (token has NOT NULL + UNIQUE: cannot use NULL; must be a unique sentinel.)
  const revokedToken = `revoked:${crypto.randomUUID()}`;
  db.run(
    "UPDATE devices SET token = ? WHERE id = ? AND vault_id = ?",
    revokedToken,
    deviceId,
    vaultId,
  );
  disconnectDeviceIfLive(vaultId, deviceId);

  log.info("device revoked", { device_id: deviceId, vault_id: vaultId });

  return jsonResp({ ok: true }, 200);
}
