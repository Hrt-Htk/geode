import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type CachedKeys,
  cachedToVaultKeys,
  isCacheValid,
} from "../../../plugin/plumbing/key-cache.ts";
import { b64encode } from "../../../core/protocol.ts";

Deno.test("key-cache - isCacheValid returns false for null", () => {
  assertFalse(isCacheValid(null, 24));
});

Deno.test("key-cache - isCacheValid returns true for fresh cache", () => {
  const cached: CachedKeys = {
    content_key: btoa("a".repeat(32)),
    mac_key: btoa("b".repeat(32)),
    nonce_key: btoa("c".repeat(32)),
    cached_at: Date.now(),
  };
  assert(isCacheValid(cached, 24));
});

Deno.test("key-cache - isCacheValid returns false for expired cache", () => {
  const cached: CachedKeys = {
    content_key: btoa("a".repeat(32)),
    mac_key: btoa("b".repeat(32)),
    nonce_key: btoa("c".repeat(32)),
    cached_at: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
  };
  assertFalse(isCacheValid(cached, 24));
});

Deno.test("key-cache - isCacheValid respects custom timeout", () => {
  const cached: CachedKeys = {
    content_key: btoa("a".repeat(32)),
    mac_key: btoa("b".repeat(32)),
    nonce_key: btoa("c".repeat(32)),
    cached_at: Date.now() - 12 * 60 * 60 * 1000, // 12 hours ago
  };
  assert(isCacheValid(cached, 24)); // valid for 24h
  assertFalse(isCacheValid(cached, 6)); // expired for 6h
});

Deno.test("key-cache - cachedToVaultKeys roundtrips bytes", () => {
  const original = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
  const b64 = b64encode(original);
  const cached: CachedKeys = {
    content_key: b64,
    mac_key: b64,
    nonce_key: b64,
    cached_at: Date.now(),
  };
  const keys = cachedToVaultKeys(cached);
  assertEquals(keys.content_key, original);
  assertEquals(keys.mac_key, original);
  assertEquals(keys.nonce_key, original);
});
