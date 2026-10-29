import { assertEquals } from "@std/assert";
import { startTestServer } from "../two-vault-driver.ts";
import {
  createDevice,
  createVault,
  listDevices,
} from "../../plugin/plumbing/provisioning-client.ts";

const ADMIN_TOKEN = "test-admin";

/**
 * Helper: send a PUT to /vaults/:vaultId/devices/:deviceId/name with an optional bearer token.
 * Returns { status, body }.
 */
async function putDeviceName(
  url: string,
  vaultId: string,
  deviceId: string,
  bearerToken: string | null,
  name: string,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(`${url}/vaults/${vaultId}/devices/${deviceId}/name`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(bearerToken ? { "Authorization": `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify({ name }),
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
  name: "device-rename: own token PUT /name → 200, new name listed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-rename");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");

      // Device A renames itself using its own token
      const result = await putDeviceName(server.url, vaultId, a.deviceId, a.token, "Renamed-A");
      assertEquals(result.status, 200, "own token should succeed");

      // Acceptance (#330): the device list shows the new name.
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      const entry = devices.find((d) => d.id === a.deviceId);
      assertEquals(entry?.name, "Renamed-A", "device list should show the new name");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-rename: own token PUT on DIFFERENT device → 403",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-rename-fb");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");
      const b = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-B");

      // A tries to rename B using A's token → should be 403
      const result = await putDeviceName(server.url, vaultId, b.deviceId, a.token, "Hijacked");
      assertEquals(result.status, 403, "should be forbidden: cannot rename another device");

      // B's name unchanged
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      const entry = devices.find((d) => d.id === b.deviceId);
      assertEquals(entry?.name, "device-B", "other device's name must be unchanged");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "device-rename: invalid token → 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer(ADMIN_TOKEN);
    try {
      const { vaultId } = await createVault(server.url, ADMIN_TOKEN, "vault-rename-bad");
      const a = await createDevice(server.url, ADMIN_TOKEN, vaultId, "device-A");

      const result = await putDeviceName(server.url, vaultId, a.deviceId, "totally-invalid", "X");
      assertEquals(result.status, 401, "invalid token should be unauthorized");

      // Name unchanged
      const devices = await listDevices(server.url, ADMIN_TOKEN, vaultId);
      const entry = devices.find((d) => d.id === a.deviceId);
      assertEquals(entry?.name, "device-A", "name must be unchanged after 401");
    } finally {
      await server.stop();
    }
  },
});
