import { assert, assertEquals } from "@std/assert";
import { deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";
import { loadKeyCache, saveKeyCache } from "../../../plugin/plumbing/key-cache.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import { tryCachedKeys, unlockVault } from "../../../plugin/plumbing/vault-lock.ts";

type Host = Parameters<typeof tryCachedKeys>[0];

// Spy on the Argon2id primitive itself: `getSodium()` caches the libsodium module object, so
// counting `crypto_pwhash` counts every derivation the lock path could make. No production hook.
async function countPwhash(): Promise<{ calls: () => number; restore: () => void }> {
  const mod = await import("libsodium-wrappers-sumo");
  const lib = ((mod as unknown as { default?: unknown }).default ?? mod) as {
    ready: Promise<void>;
    crypto_pwhash: (...args: unknown[]) => Uint8Array;
  };
  await lib.ready;
  const original = lib.crypto_pwhash;
  let calls = 0;
  lib.crypto_pwhash = (...args: unknown[]) => {
    calls++;
    return original(...args);
  };
  return { calls: () => calls, restore: () => (lib.crypto_pwhash = original) };
}

function makeHost(): { host: Host; storage: Map<string, string | null>; restarts: number[] } {
  const storage = new Map<string, string | null>();
  const restarts: number[] = [];
  const settings = {
    ...DEFAULT_SETTINGS,
    serverUrl: "",
    vaultId: "vault",
    deviceToken: "",
    salt: b64encode(new Uint8Array(16).fill(7)),
    verifier: "",
    argon2Params: { ops: 1, mem: 8192 },
    unlockTimeoutHours: 24,
  };
  const host = {
    pluginSettings: settings,
    keys: null as unknown,
    isUnlocked: false,
    app: {
      vault: { adapter: { remove: () => Promise.resolve() } },
      saveLocalStorage: (key: string, value: unknown) => {
        storage.set(key, value as string | null);
      },
      loadLocalStorage: (key: string) => storage.get(key) ?? null,
    },
    restartUnlockedSession: () => {
      restarts.push(1);
      return Promise.resolve();
    },
    saveSettings: () => Promise.resolve(),
    settingTab: null,
  } as unknown as Host;
  return { host, storage, restarts };
}

Deno.test("tryCachedKeys: the cached unlock makes no Argon2id call", async () => {
  const salt = new Uint8Array(16).fill(7);
  const keys = await deriveKeys("passphrase", salt, { opsLimit: 1, memLimit: 8192 });
  const { host, storage, restarts } = makeHost();
  host.pluginSettings.verifier = b64encode(await makeVerifier(keys));
  saveKeyCache((json) => storage.set("key-cache", json), keys);
  const pwhash = await countPwhash();

  try {
    assertEquals(await tryCachedKeys(host), true, "a valid cache unlocks");
    assertEquals(pwhash.calls(), 0, "the cached path never runs Argon2id");
    assertEquals(host.isUnlocked, true);
    assertEquals(host.keys, keys);
    assertEquals(restarts.length, 1, "the session restarts once");

    // Cache cleared: the next unlock takes the slow passphrase path, deriving exactly once.
    host.isUnlocked = false;
    host.keys = null;
    storage.set("key-cache", null);
    assertEquals(await tryCachedKeys(host), false, "no cache means a passphrase prompt");
    assertEquals(pwhash.calls(), 0, "the miss derives nothing");
    await unlockVault(host, "passphrase");
    assertEquals(pwhash.calls(), 1, "the slow path derives once");
    assert(
      loadKeyCache(() => storage.get("key-cache") ?? null),
      "the slow path re-primes the cache",
    );
  } finally {
    pwhash.restore();
  }
});
