// The re-key credential gate (#556): the vault stores auth_hash = blake3(auth_key), so
// every session call needs the vault-pinned device token AND a hex auth_key whose hash
// matches it. The first auth_hash write additionally needs the admin token (#675): a
// device token alone would let whoever writes first own every /rekey route. Own module
// so rekey-routes.ts is the session endpoints only.
import { authHashHex } from "../core/crypto.ts";
import type { Database } from "./db.ts";
import type { DeviceInfo } from "./auth.ts";
import { jsonResp, readJson, requireAdminHeader, requireDevice } from "./http-helpers.ts";
import { log } from "./log.ts";

const AUTH_KEY_HEADER = "x-geode-auth-key";

/** A 64-char lowercase hex credential: the auth_key a client holds and the auth_hash a
 * vault stores. */
export const HEX64 = /^[0-9a-f]{64}$/;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Device token (vault-pinned) + auth_key matching the stored auth_hash.
// Missing auth_hash → 409 "auth not registered" (TOFU via PUT /auth first).
export function requireRekeyAuth(
  db: Database,
  req: Request,
  vaultId: string,
): DeviceInfo | Response {
  const device = requireDevice(db, req, vaultId);
  if (device instanceof Response) return device;
  const row = db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(vaultId) as {
    auth_hash: string | null;
  } | null;
  if (!row) return jsonResp({ error: "vault not found" }, 404);
  if (row.auth_hash === null) return jsonResp({ error: "auth not registered" }, 409);
  const authKey = req.headers.get(AUTH_KEY_HEADER);
  if (!authKey || !HEX64.test(authKey)) return jsonResp({ error: "auth key required" }, 403);
  if (!constantTimeEqual(authHashHex(hexToBytes(authKey)), row.auth_hash)) {
    return jsonResp({ error: "auth key mismatch" }, 403);
  }
  return device;
}

// Trust on first use: sets auth_hash only while it is NULL, and only for a
// caller holding the admin token as well.
export async function handlePutAuth(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Promise<Response> {
  const device = requireDevice(db, req, vaultId);
  if (device instanceof Response) return device;
  const body = await readJson<{ auth_key?: unknown }>(req);
  if (body instanceof Response) return body;
  const authKey = body?.auth_key;
  if (typeof authKey !== "string" || !HEX64.test(authKey)) {
    return jsonResp({ error: "auth_key must be 64 hex chars" }, 400);
  }
  const row = db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(vaultId) as {
    auth_hash: string | null;
  } | null;
  if (!row) return jsonResp({ error: "vault not found" }, 404);
  const hash = authHashHex(hexToBytes(authKey));
  if (row.auth_hash !== null) {
    // Every unlock re-registers; only a different key is refused.
    if (row.auth_hash !== hash) return jsonResp({ error: "auth already registered" }, 409);
    return jsonResp({ ok: true }, 200);
  }
  const denied = requireAdminHeader(req, adminToken);
  if (denied) return denied;
  db.run("UPDATE vaults SET auth_hash = ? WHERE id = ?", hash, vaultId);
  log.warn("auth hash registered", { vault_id: vaultId, device_id: device.device_id });
  return jsonResp({ ok: true }, 200);
}
