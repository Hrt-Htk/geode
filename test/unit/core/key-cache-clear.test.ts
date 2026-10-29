import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type CachedKeys,
  cachedToVaultKeys,
  clearKeyCache,
  isCacheValid,
  LEGACY_CACHE_FILE,
  loadKeyCache,
  removeLegacyKeyCacheFile,
  resolveCachedKeys,
  saveKeyCache,
} from "../../../plugin/plumbing/key-cache.ts";
import { subscribeLog } from "../../../plugin/plumbing/log.ts";
import { b64encode } from "../../../core/protocol.ts";

// Fake per-device store mirroring the app.saveLocalStorage/loadLocalStorage contract:
// string in/out, null means "absent", save(null) clears the entry.
class FakeStore {
  value: string | null = null;
  load = (): string | null => this.value;
  save = (data: string | null): void => {
    this.value = data;
  };
}

function validCached(): CachedKeys {
  const key = (n: number) => new Uint8Array(Array.from({ length: 32 }, (_, i) => i + n));
  return {
    content_key: b64encode(key(1)),
    mac_key: b64encode(key(2)),
    nonce_key: b64encode(key(3)),
    cached_at: Date.now(),
  };
}

Deno.test("key-cache - saveKeyCache writes base64 keys + fresh cached_at to the store", () => {
  const store = new FakeStore();
  const keys = {
    content_key: new Uint8Array(32).fill(1),
    mac_key: new Uint8Array(32).fill(2),
    nonce_key: new Uint8Array(32).fill(3),
  };
  saveKeyCache((json) => store.save(json), keys);
  const parsed = JSON.parse(store.value!) as CachedKeys;
  assertEquals(parsed.content_key, b64encode(keys.content_key));
  assertEquals(parsed.mac_key, b64encode(keys.mac_key));
  assertEquals(parsed.nonce_key, b64encode(keys.nonce_key));
  assert(isCacheValid(parsed, 24), "saved cache must be fresh");
});

Deno.test("key-cache - loadKeyCache roundtrips a saved cache", () => {
  const store = new FakeStore();
  saveKeyCache((json) => store.save(json), {
    content_key: new Uint8Array(32).fill(1),
    mac_key: new Uint8Array(32).fill(2),
    nonce_key: new Uint8Array(32).fill(3),
  });
  const loaded = loadKeyCache(store.load);
  assert(loaded, "expected a loaded cache");
  const keys = resolveCachedKeys(loaded);
  assertEquals(keys?.content_key, new Uint8Array(32).fill(1));
});

Deno.test("key-cache - loadKeyCache returns null for an empty store", () => {
  assertEquals(loadKeyCache(() => null), null);
});

Deno.test("key-cache - loadKeyCache treats corrupt JSON as a cache miss (null), no throw", () => {
  assertEquals(loadKeyCache(() => "{not json"), null);
});

Deno.test("key-cache-clear - clearKeyCache clears the store entry", () => {
  const store = new FakeStore();
  store.save("{}");
  clearKeyCache(() => store.save(null));
  assertEquals(store.value, null);
});

Deno.test("key-cache-clear - clearKeyCache logs a throwing clear instead of swallowing it", () => {
  const errors: string[] = [];
  const unsub = subscribeLog((e) => {
    if (e.level === "error") errors.push(e.msg);
  });
  try {
    clearKeyCache(() => {
      throw new Error("disk full");
    });
  } finally {
    unsub();
  }
  assertEquals(errors.length, 1);
});

Deno.test("key-cache-migration - removeLegacyKeyCacheFile deletes the legacy in-vault file when present", async () => {
  const files = new Map<string, string>([[LEGACY_CACHE_FILE, "{}"]]);
  const removed: string[] = [];
  await removeLegacyKeyCacheFile(
    (p) => files.has(p),
    (p) => {
      files.delete(p);
      removed.push(p);
    },
  );
  assertFalse(files.has(LEGACY_CACHE_FILE));
  assertEquals(removed, [LEGACY_CACHE_FILE]);
});

Deno.test("key-cache-migration - removeLegacyKeyCacheFile is a no-op when the legacy file is absent", async () => {
  const removed: string[] = [];
  await removeLegacyKeyCacheFile(() => false, (p) => removed.push(p));
  assertEquals(removed, []);
});

Deno.test("key-cache-clear - resolveCachedKeys returns keys for a valid cache", () => {
  const cached = validCached();
  const keys = resolveCachedKeys(cached);
  assert(keys, "expected resolved keys");
  assertEquals(keys, cachedToVaultKeys(cached));
});

Deno.test("key-cache-clear - resolveCachedKeys treats a corrupt field as a cache miss (null), no throw", () => {
  const corrupt: CachedKeys = {
    content_key: "!!!not-base64!!!",
    mac_key: "aGVsbG8=",
    nonce_key: "d29ybGQ=",
    cached_at: Date.now(),
  };
  assertEquals(resolveCachedKeys(corrupt), null);
});

Deno.test("key-cache-clear - resolveCachedKeys returns null for missing cache", () => {
  assertEquals(resolveCachedKeys(null), null);
});
