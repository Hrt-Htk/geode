import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { startTestServer, TestPlugin } from "../two-vault-driver.ts";
import {
  createDevice,
  createVault,
  listVaults,
  putVerifier,
  revokeDevice,
} from "../../plugin/plumbing/provisioning-client.ts";
import { checkVerifier, deriveKeys, makeVerifier } from "../../core/crypto.ts";
import { validateToken } from "../../server/auth.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";

const ADMIN_TOKEN = "test-admin";
const PASSPHRASE = "test"; // TestPlugin.start() hardcodes "test" as passphrase

function decodeSalt(saltB64: string): Uint8Array {
  return b64decode(saltB64);
}

Deno.test({
  name: "admin-token join: B joins from scratch, correct passphrase, syncs with A",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      // 1. Create vault
      const { vaultId } = await createVault(
        server.url,
        ADMIN_TOKEN,
        "vault-A",
      );

      // 2. Verify vault appears in list
      const vaults = await listVaults(server.url, ADMIN_TOKEN);
      const found = vaults.find((v) => v.id === vaultId);
      assertExists(found, "vault should appear in list");
      assertEquals(found.name, "vault-A");

      // 3. Device A: create, derive keys, store verifier
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      assertEquals(a.verifier, null, "fresh vault has no verifier");

      const saltBytes = decodeSalt(a.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);
      // #675: a first (NULL) verifier write needs the admin token as well.
      await putVerifier(server.url, vaultId, a.token, verifierB64, undefined, ADMIN_TOKEN);

      // 4. Device B: admin join from scratch
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");
      assertExists(b.salt, "B should receive salt");
      assertNotEquals(b.verifier, null, "B should receive verifier set by A");

      // 5. Verify B's passphrase checks out
      const keysB = await deriveKeys(PASSPHRASE, decodeSalt(b.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierOk = await checkVerifier(keysB, b64decode(b.verifier!));
      assertEquals(verifierOk, true, "correct passphrase should pass verifier");

      // 6. Start both as TestPlugins and sync
      const pluginA = new TestPlugin({
        url: server.url,
        vaultId,
        deviceId: a.deviceId,
        deviceToken: a.token,
        passphrase: PASSPHRASE,
        saltBytes: decodeSalt(a.salt),
      });
      const pluginB = new TestPlugin({
        url: server.url,
        vaultId,
        deviceId: b.deviceId,
        deviceToken: b.token,
        passphrase: PASSPHRASE,
        saltBytes: decodeSalt(b.salt),
      });

      await pluginA.start();
      await pluginB.start();

      // B writes a file
      const path = "hello-from-b.md";
      const content = "Hello from device B!";
      pluginB.fakeVault.write(path, content);
      await pluginB.flushPending();

      // A should receive it
      await pluginA.waitForVersion(path);
      const received = new TextDecoder().decode(
        await pluginA.fakeVault.readBinary(path),
      );
      assertEquals(received, content);

      pluginA.stop();
      pluginB.stop();
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "admin-token join: wrong passphrase fails verifier",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      // Set up vault + device A with verifier
      const { vaultId } = await createVault(
        server.url,
        ADMIN_TOKEN,
        "vault-bad-pw",
      );

      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      assertEquals(a.verifier, null);

      const keysA = await deriveKeys(PASSPHRASE, decodeSalt(a.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);
      // #675: a first (NULL) verifier write needs the admin token as well.
      await putVerifier(server.url, vaultId, a.token, verifierB64, undefined, ADMIN_TOKEN);

      // Device B joins: derive keys with WRONG passphrase
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");
      assertExists(b.verifier, "B should receive verifier");

      const keysWrong = await deriveKeys("nope", decodeSalt(b.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierOk = await checkVerifier(keysWrong, b64decode(b.verifier!));
      assertEquals(verifierOk, false, "wrong passphrase should fail verifier");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "revoke device: revoked token no longer validates, other device unaffected",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(
        server.url,
        ADMIN_TOKEN,
        "vault-revoke",
      );

      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");

      // Both tokens validate before revoke
      const aBefore = validateToken(server.db, a.token);
      const bBefore = validateToken(server.db, b.token);
      assertExists(aBefore, "A token should validate");
      assertExists(bBefore, "B token should validate");

      // Revoke B
      await revokeDevice(server.url, ADMIN_TOKEN, vaultId, b.deviceId);

      // B token no longer validates
      const bAfter = validateToken(server.db, b.token);
      assertEquals(bAfter, null, "revoked B token should be null");

      // A token still validates
      const aAfter = validateToken(server.db, a.token);
      assertExists(aAfter, "A token should still validate after B revoked");
    } finally {
      await server.stop();
    }
  },
});
