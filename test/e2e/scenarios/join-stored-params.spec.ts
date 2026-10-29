import { expect, test } from "@playwright/test";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { type ObsidianInstance, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";
import { b64decode, b64encode } from "../../../core/protocol";

/**
 * #298: verify that argon2 params travel with the vault so a correct passphrase
 * verifies on any device.
 *
 * Two cases:
 *   1. Stored-params: server stores {ops:3,mem:67108864}; fresh instance with DIFFERENT
 *      local default joins successfully using the server's params.
 *   2. NULL params + verifier matching the current default: join backfills those params.
 */

const PASSPHRASE = "correct horse";

// ── Inline crypto helpers (mirrors core/crypto.ts + base64 util) ──

async function getSodium(): Promise<{
  crypto_pwhash: (
    keyLen: number,
    passphrase: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    alg: number,
  ) => Uint8Array;
  crypto_pwhash_OPSLIMIT_MODERATE: number;
  crypto_pwhash_MEMLIMIT_MODERATE: number;
  crypto_pwhash_ALG_ARGON2ID13: number;
  crypto_aead_xchacha20poly1305_ietf_encrypt: (
    m: Uint8Array,
    aad: Uint8Array | null,
    secretNonce: Uint8Array | null,
    nonce: Uint8Array,
    k: Uint8Array,
  ) => Uint8Array;
  randombytes_buf: (len: number) => Uint8Array;
}> {
  const mod = require("libsodium-wrappers-sumo");
  const lib = ((mod as unknown as { default?: unknown }).default ?? mod) as Record<string, unknown>;
  await (lib as Record<string, unknown>).ready;
  return lib as unknown as {
    crypto_pwhash: (
      keyLen: number,
      passphrase: string | Uint8Array,
      salt: Uint8Array,
      opsLimit: number,
      memLimit: number,
      alg: number,
    ) => Uint8Array;
    crypto_pwhash_OPSLIMIT_MODERATE: number;
    crypto_pwhash_MEMLIMIT_MODERATE: number;
    crypto_pwhash_ALG_ARGON2ID13: number;
    crypto_aead_xchacha20poly1305_ietf_encrypt: (
      m: Uint8Array,
      aad: Uint8Array | null,
      secretNonce: Uint8Array | null,
      nonce: Uint8Array,
      k: Uint8Array,
    ) => Uint8Array;
    randombytes_buf: (len: number) => Uint8Array;
  };
}

async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  params: { opsLimit: number; memLimit: number },
): Promise<{ content_key: Uint8Array; mac_key: Uint8Array; nonce_key: Uint8Array }> {
  const sodium = await getSodium();
  const masterKey = sodium.crypto_pwhash(
    32,
    passphrase,
    salt,
    params.opsLimit,
    params.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  const { hkdf } = await import("@noble/hashes/hkdf.js");
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const label = (info: string) => hkdf(sha256, masterKey, salt, new TextEncoder().encode(info), 32);
  return {
    content_key: label("geode/content/v1"),
    mac_key: label("geode/mac/v1"),
    nonce_key: label("geode/nonce/v1"),
  };
}

async function makeVerifier(keys: { content_key: Uint8Array }): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(24);
  const pt = new TextEncoder().encode("geode-verifier-v1");
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pt,
    null,
    null,
    nonce,
    keys.content_key,
  );
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return out;
}

async function setVerifierOnServer(
  serverUrl: string,
  vaultId: string,
  token: string,
  passphrase: string,
  salt: string,
  params: { ops: number; mem: number },
  includeParams: boolean,
): Promise<string> {
  const keys = await deriveKeys(passphrase, b64decode(salt), {
    opsLimit: params.ops,
    memLimit: params.mem,
  });
  const verifierBytes = await makeVerifier(keys);
  const verifierB64 = b64encode(verifierBytes);
  const body: { verifier: string; argon2_ops?: number; argon2_mem?: number } = {
    verifier: verifierB64,
  };
  if (includeParams) {
    body.argon2_ops = params.ops;
    body.argon2_mem = params.mem;
  }
  // #675: a first (NULL) verifier write needs the admin token as well.
  await fetch(`${serverUrl}/vaults/${vaultId}/verifier`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-geode-admin-token": "e2e",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return verifierB64;
}

// ── Case 1: Stored params: server stores {ops:3,mem:67108864}, fresh instance joins successfully ──

test("stored params: fresh instance joins using server-stored argon2 params", async () => {
  test.slow();
  const server = await startServer();
  try {
    const deviceA = await server.mintToken("device-A");

    // Build verifier with PROD params AND store params on server.
    await setVerifierOnServer(
      server.url,
      server.vaultId,
      deviceA.token,
      PASSPHRASE,
      server.salt,
      { ops: 3, mem: 67108864 },
      true,
    );

    // Verify server stored the params.
    const infoRes = await fetch(`${server.url}/vaults/${server.vaultId}/info`, {
      headers: { authorization: `Bearer e2e` },
    });
    const infoJson = await infoRes.json() as {
      argon2_ops: number | null;
      argon2_mem: number | null;
    };
    expect(infoJson.argon2_ops).toBe(3);
    expect(infoJson.argon2_mem).toBe(67108864);

    // Launch fresh instance (local default = test params: ops=1, mem=8192).
    const B = await launchUnconfigured(server, { keepStartupModal: true });
    try {
      await waitForPluginLoaded(B);
      await B.eval(
        `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
      );
      await B.win.locator('[data-testid="geode-join-server"]').waitFor();

      await B.eval(`
        document.querySelector('[data-testid="geode-join-server"]').value = ${
        JSON.stringify(server.url)
      };
        document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
        document.querySelector('[data-testid="geode-join-load"]').click();
        return true;
      `);
      await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

      await B.eval(`
        const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
        sel.value = ${JSON.stringify(server.vaultId)};
        sel.dispatchEvent(new Event('change'));
        document.querySelector('[data-testid="geode-join-device-name"]').value = "fresh-device";
        document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
        JSON.stringify(PASSPHRASE)
      };
        document.querySelector('[data-testid="geode-join-submit"]').click();
        return true;
      `);

      // After the fix: the join should SUCCEED because orchestrateAdminJoin uses the
      // vault's stored params (ops=3, mem=67108864) instead of the local default.
      // Poll: the join is async (network + a slow ops:3 argon2 derivation).
      await waitForUnlocked(B);
    } finally {
      await B.close();
    }
  } finally {
    await server.stop();
  }
});

// ── Case 2: NULL params + verifier matching the CURRENT default backfills those params (#356) ──

async function joinFreshDevice(
  server: Awaited<ReturnType<typeof startServer>>,
): Promise<ObsidianInstance> {
  const B = await launchUnconfigured(server, { keepStartupModal: true });
  await waitForPluginLoaded(B);
  await B.eval(`document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`);
  await B.win.locator('[data-testid="geode-join-server"]').waitFor();

  await B.eval(`
    document.querySelector('[data-testid="geode-join-server"]').value = ${
    JSON.stringify(server.url)
  };
    document.querySelector('[data-testid="geode-join-admin"]').value = "e2e";
    document.querySelector('[data-testid="geode-join-load"]').click();
    return true;
  `);
  await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

  await B.eval(`
    const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
    sel.value = ${JSON.stringify(server.vaultId)};
    sel.dispatchEvent(new Event('change'));
    document.querySelector('[data-testid="geode-join-device-name"]').value = "fresh-device";
    document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
    JSON.stringify(PASSPHRASE)
  };
    document.querySelector('[data-testid="geode-join-submit"]').click();
    return true;
  `);
  return B;
}

test("null params + current default: NULL params + verifier matching current default backfills", async () => {
  test.slow();
  const server = await startServer();
  try {
    const deviceA = await server.mintToken("device-A");

    // Verifier built under the CURRENT default test params but params are NOT
    // stored on the server: a legacy vault whose verifier happens to match the
    // device's current default. This is the exact lockout path from #356.
    await setVerifierOnServer(
      server.url,
      server.vaultId,
      deviceA.token,
      PASSPHRASE,
      server.salt,
      { ops: TEST_ARGON2_PARAMS.ops, mem: TEST_ARGON2_PARAMS.mem },
      false,
    );

    const infoRes = await fetch(`${server.url}/vaults/${server.vaultId}/info`, {
      headers: { authorization: `Bearer e2e` },
    });
    const infoJson = await infoRes.json() as {
      argon2_ops: number | null;
      argon2_mem: number | null;
    };
    expect(infoJson.argon2_ops).toBeNull();
    expect(infoJson.argon2_mem).toBeNull();

    const B = await joinFreshDevice(server);
    try {
      // Fresh instance local default = test params, matching the verifier, so the
      // join succeeds via the PRIMARY path (no legacy retry needed).
      await waitForUnlocked(B);

      // The NULL params must now be backfilled on the server with the params that verified.
      const infoRes2 = await fetch(`${server.url}/vaults/${server.vaultId}/info`, {
        headers: { authorization: `Bearer e2e` },
      });
      const infoJson2 = await infoRes2.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      expect(infoJson2.argon2_ops, "server should now advertise the current default ops").toBe(
        TEST_ARGON2_PARAMS.ops,
      );
      expect(infoJson2.argon2_mem, "server should now advertise the current default mem").toBe(
        TEST_ARGON2_PARAMS.mem,
      );
    } finally {
      await B.close();
    }
  } finally {
    await server.stop();
  }
});
