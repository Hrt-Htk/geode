import { VaultKeys } from "../../core/crypto.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";
import { formatError, log } from "./log.ts";

export interface CachedKeys {
  content_key: string; // base64
  mac_key: string; // base64
  nonce_key: string; // base64
  cached_at: number; // epoch ms
}

// #534: the legacy in-vault cache file. On upgrade it is deleted, never
// imported: a copied vault may carry a copy of the keys.
export const LEGACY_CACHE_FILE = ".geode_key_cache.json";

// The store is a per-device, vault-scoped string store (app.saveLocalStorage /
// loadLocalStorage): string in, string out, null means absent.
export function loadKeyCache(read: () => string | null): CachedKeys | null {
  try {
    const data = read();
    if (!data) return null;
    return JSON.parse(data) as CachedKeys;
  } catch {
    return null;
  }
}

export function saveKeyCache(write: (json: string) => void, keys: VaultKeys): void {
  const cached: CachedKeys = {
    content_key: b64encode(keys.content_key),
    mac_key: b64encode(keys.mac_key),
    nonce_key: b64encode(keys.nonce_key),
    cached_at: Date.now(),
  };
  write(JSON.stringify(cached));
}

export function clearKeyCache(clear: () => void): void {
  try {
    clear();
  } catch (error) {
    log.error("failed to clear key cache", { error: formatError(error) });
  }
}

// #534: one-time migration: delete the legacy in-vault key cache file.
export async function removeLegacyKeyCacheFile(
  exists: (path: string) => Promise<boolean>,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  if (await exists(LEGACY_CACHE_FILE)) {
    await remove(LEGACY_CACHE_FILE);
  }
}

export function isCacheValid(cached: CachedKeys | null, timeoutHours: number): boolean {
  if (!cached) return false;
  const ageMs = Date.now() - cached.cached_at;
  const timeoutMs = timeoutHours * 60 * 60 * 1000;
  return ageMs < timeoutMs;
}

export function cachedToVaultKeys(cached: CachedKeys): VaultKeys {
  return {
    content_key: b64decode(cached.content_key),
    mac_key: b64decode(cached.mac_key),
    nonce_key: b64decode(cached.nonce_key),
  };
}

// Corruption-tolerant resolution: a torn/corrupt cache (valid JSON, bad base64 field)
// counts as a cache miss rather than throwing through the caller's promise chain.
export function resolveCachedKeys(cached: CachedKeys | null): VaultKeys | null {
  if (!cached) return null;
  try {
    return cachedToVaultKeys(cached);
  } catch {
    return null;
  }
}
