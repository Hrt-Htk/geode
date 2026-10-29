import { assertEquals } from "@std/assert";
import { revokeDeviceSelf, setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";

Deno.test("revokeDeviceSelf - issues DELETE with device token", async () => {
  let captured: { url: string; method: string; headers: Record<string, string> } | null = null;

  setHttpImpl((req) => {
    captured = req;
    return Promise.resolve({ status: 200, text: '{"ok":true}' });
  });

  const serverUrl = "https://geode.example.com";
  const vaultId = "vault-abc123";
  const deviceToken = "dev-tok-000111222";
  const deviceId = "device-xyz789";

  await revokeDeviceSelf(serverUrl, vaultId, deviceToken, deviceId);

  assertEquals(captured?.url, `${serverUrl}/vaults/${vaultId}/devices/${deviceId}`);
  assertEquals(captured?.method, "DELETE");
  assertEquals(captured?.headers["Authorization"], `Bearer ${deviceToken}`);
});
