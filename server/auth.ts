import type { Database } from "@db/sqlite";

export type DeviceInfo = { device_id: string; vault_id: string };

const CACHE_TTL_MS = 60_000;
const tokenCache = new Map<string, { info: DeviceInfo; expires: number }>();

export function validateToken(db: Database, token: string): DeviceInfo | null {
  const entry = tokenCache.get(token);
  if (entry && entry.expires > Date.now()) {
    // #680: a cached entry would keep a deleted vault's token alive for up to a minute,
    // which is exactly the window the `vaults` join closes. One primary-key lookup re-checks.
    if (vaultExists(db, entry.info.vault_id)) return entry.info;
    tokenCache.delete(token);
    return null;
  }
  try {
    // #680: joined to the vault, so a device row that outlived its vault (a manual
    // sqlite delete runs with foreign_keys off, so no cascade) is not a valid token.
    const row = db.prepare(
      "SELECT d.id as device_id, d.vault_id FROM devices d JOIN vaults v ON v.id = d.vault_id WHERE d.token = ? LIMIT 1",
    ).get(token) as { device_id: string; vault_id: string } | null;
    if (!row) return null;
    const info: DeviceInfo = { device_id: row.device_id, vault_id: row.vault_id };
    tokenCache.set(token, { info, expires: Date.now() + CACHE_TTL_MS });
    return info;
  } catch {
    return null;
  }
}

function vaultExists(db: Database, vaultId: string): boolean {
  try {
    return db.prepare("SELECT 1 FROM vaults WHERE id = ?").get(vaultId) !== undefined;
  } catch {
    return false;
  }
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

export function validateAdminToken(token: string, expected: string | null): boolean {
  if (!expected) return false;
  return constantTimeEqual(token, expected);
}

export function parseBearerHeader(headerValue: string | null): string | null {
  if (!headerValue) return null;
  if (!headerValue.startsWith("Bearer ")) return null;
  return headerValue.slice(7).trim();
}

export function parseSubprotocolBearer(headerValue: string): string | null {
  if (!headerValue.startsWith("bearer.")) return null;
  return headerValue.slice(7);
}

export function touchDeviceLastSeen(db: Database, deviceId: string): void {
  try {
    db.run(
      "UPDATE devices SET last_seen_at = ? WHERE id = ?",
      Math.floor(Date.now() / 1000),
      deviceId,
    );
  } catch {
    // best-effort
  }
}
