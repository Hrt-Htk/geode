import { assertEquals } from "@std/assert";
import { renameDeviceSelf, setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";

Deno.test("renameDeviceSelf - issues PUT with device token", async () => {
  let captured:
    | { url: string; method: string; headers: Record<string, string>; body?: string }
    | null = null;

  setHttpImpl((req) => {
    captured = req;
    return Promise.resolve({ status: 200, text: '{"ok":true}' });
  });

  const serverUrl = "https://geode.example.com";
  const vaultId = "vault-abc123";
  const deviceToken = "dev-tok-000111222";
  const deviceId = "device-xyz789";

  await renameDeviceSelf(serverUrl, vaultId, deviceToken, deviceId, "My New Name");

  assertEquals(captured?.url, `${serverUrl}/vaults/${vaultId}/devices/${deviceId}/name`);
  assertEquals(captured?.method, "PUT");
  assertEquals(captured?.headers["Authorization"], `Bearer ${deviceToken}`);
  assertEquals(JSON.parse(captured?.body ?? "{}"), { name: "My New Name" });
});
