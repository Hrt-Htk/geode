import { assertEquals, assertExists } from "@std/assert";
import { startTestServer } from "../two-vault-driver.ts";
import {
  createDevice,
  createVault,
  listDevices,
} from "../../plugin/plumbing/provisioning-client.ts";
import { validateToken } from "../../server/auth.ts";

const ADMIN_TOKEN = "test-admin";

/**
 * Helper: send a DELETE to /vaults/:vaultId/devices/:deviceId with an optional bearer token.
 * Returns { status, body }.
 */
async function deleteDevice(
  url: string,
  vaultId: string,
  deviceId: string,
  bearerToken: string | null,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${url}/vaults/${vaultId}/devices/${deviceId}`, {
      method: "DELETE",
      headers: bearerToken ? { "Authorization": `Bearer ${bearerToken}` } : {},
    });
    let body: unknown;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

Deno.test({
  name: "device-self-revoke: own token DELETEs own device → success",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-self-revoke");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");

      // Both tokens valid before
      assertExists(validateToken(server.db, a.token), "A token valid before");
      assertExists(validateToken(server.db, b.token), "B token valid before");

      // Device A revokes itself using its own token
      const result = await deleteDevice(server.url, vaultId, a.deviceId, a.token);
      assertEquals(result.status, 200, "own token should succeed");

      // A's token no longer validates
      assertEquals(validateToken(server.db, a.token), null, "A's token should be revoked");

      // B is unaffected
      assertExists(validateToken(server.db, b.token), "B's token should still work");

      // Acceptance (#312): the left device no longer appears in the vault's device list.
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      assertEquals(devices.length, 1, "revoked device no longer listed");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-self-revoke: own token DELETEing DIFFERENT device → 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-fb");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");

      // A tries to revoke B using A's token → should be 403
      const result = await deleteDevice(server.url, vaultId, b.deviceId, a.token);
      assertEquals(result.status, 403, "should be forbidden: cannot revoke another device");

      // Both still present
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      assertEquals(devices.length, 2, "both devices still present");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-self-revoke: admin token DELETE still works (no regression)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-admin");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");

      // Both tokens validate before admin revoke
      assertExists(validateToken(server.db, a.token), "A token valid before");
      assertExists(validateToken(server.db, b.token), "B token valid before");

      // Admin revokes B
      const result = await deleteDevice(server.url, vaultId, b.deviceId, ADMIN_TOKEN);
      assertEquals(result.status, 200, "admin should still be able to revoke");

      // B's token no longer validates, A's still does
      assertEquals(validateToken(server.db, b.token), null, "B's token revoked by admin");
      assertExists(validateToken(server.db, a.token), "A's token still valid");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-self-revoke: no token → 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-no-token");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");

      // No token at all
      const result = await deleteDevice(server.url, vaultId, a.deviceId, null);
      assertEquals(result.status, 401, "no token should be unauthorized");

      // Device still present
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      assertEquals(devices.length, 1, "device still present");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-self-revoke: invalid token → 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-bad-token");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");

      // Invalid token
      const result = await deleteDevice(server.url, vaultId, a.deviceId, "totally-invalid");
      assertEquals(result.status, 401, "invalid token should be unauthorized");

      // Device still present
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      assertEquals(devices.length, 1, "device still present");
    } finally {
      await server.stop();
    }
  },
});
