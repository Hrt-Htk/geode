import { assertEquals } from "@std/assert";
import { startTestServer, TestPlugin, TestServer, waitFor } from "../../two-vault-driver.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";

async function addPlugin(
  server: TestServer,
  vaultId: string,
  salt: Uint8Array,
  name: string,
  pluginVersion?: string,
): Promise<TestPlugin> {
  const deviceId = crypto.randomUUID();
  const token = crypto.randomUUID();
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    name,
    token,
  );
  const plugin = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId,
    deviceToken: token,
    passphrase: "test",
    saltBytes: salt,
    pluginVersion,
  });
  await plugin.start();
  return plugin;
}

Deno.test({
  name: "version gate - compatible version difference keeps sync running (#529)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer();
    const vaultId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    server.db.run(
      "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
      vaultId,
      "test-vault",
      salt,
      Date.now(),
    );

    let A: TestPlugin;
    let B: TestPlugin;
    try {
      // A matches the server version (default); B sends a stale but compatible version.
      A = await addPlugin(server, vaultId, salt, "device-A");
      B = await addPlugin(server, vaultId, salt, "device-B", "0.0.1");

      // A plain version difference is allowed now (#529): B must NOT be blocked.
      assertEquals(B.transport.getState(), "live", "compatible B should be live");
      assertEquals(B.isBlocked(), false, "compatible B should not be blocked");
      // B learns the server version from hello_ack (feeds the plugin's update hint).
      assertEquals(B.transport.getServerVersion(), SERVER_VERSION);

      // A (matched) stays live and unaffected.
      assertEquals(A.transport.getState(), "live", "matched A should be live");

      // A authors a file; the compatible client receives it: sync keeps running.
      A.fakeVault.write("only-a.md", "secret");
      await A.flushPending();
      await waitFor(
        () => B.fakeVault.files.has("only-a.md"),
        "B to receive A's synced file",
      );
      assertEquals(
        B.fakeVault.files.has("only-a.md"),
        true,
        "compatible B must receive synced content",
      );
    } finally {
      try {
        A!.stop();
      } catch { /* teardown is best-effort */ }
      try {
        B!.stop();
      } catch { /* teardown is best-effort */ }
      await server.stop();
    }
  },
});
