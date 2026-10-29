import { assert, assertEquals } from "@std/assert";
import { checkVerifier, deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64decode, b64encode } from "../../../core/protocol.ts";
import { loadKeyCache } from "../../../plugin/plumbing/key-cache.ts";
import { finishRekey } from "../../../plugin/plumbing/vault-lock.ts";

Deno.test("finishRekey: saves the new key cache, updates settings, restarts the session", async () => {
  const salt = new Uint8Array(16).fill(3);
  const newKeys = await deriveKeys("new", salt, { opsLimit: 1, memLimit: 8192 });
  const verifierB64 = b64encode(await makeVerifier(newKeys));
  const storage = new Map<string, string | null>();
  const order: string[] = [];
  const host = {
    settings: {
      serverUrl: "http://localhost:1",
      vaultId: "v",
      deviceToken: "t",
      salt: b64encode(salt),
      verifier: "old-verifier",
      argon2Params: { ops: 9, mem: 9 },
    },
    keys: null,
    isUnlocked: false,
    app: {
      saveLocalStorage: (k: string, v: string | null) => {
        storage.set(k, v);
      },
      loadLocalStorage: (k: string) => storage.get(k) ?? null,
    },
    saveSettings: async () => {},
    restartUnlockedSession: () => {
      order.push("restart");
    },
    // #464: a surface holding decrypted content must go before the restart.
    onKeysChanged: () => order.push("keys-changed"),
    settingTab: null,
  } as unknown as Parameters<typeof finishRekey>[0];

  await finishRekey(host, newKeys, { ops: 2, mem: 4096 }, verifierB64);

  assertEquals(order, ["keys-changed", "restart"]);
  assertEquals(host.isUnlocked, true);
  assertEquals(host.settings.verifier, verifierB64);
  assertEquals(host.settings.argon2Params, { ops: 2, mem: 4096 });
  const cached = loadKeyCache(() => storage.get("key-cache") ?? null);
  assert(cached, "key cache written");
  assert(
    await checkVerifier(
      { content_key: newKeys.content_key, mac_key: newKeys.mac_key, nonce_key: newKeys.nonce_key },
      b64decode(verifierB64),
    ),
  );
});
