import { VaultHub } from "../../../server/ws.ts";
import { type Database, openDb } from "../../../server/db.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assert, assertEquals } from "@std/assert";
import { makeFakeSocket } from "../../helpers/fake-socket.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function ensureVaultAndDevice(db: Database, vaultId: string, deviceId: string): void {
  db.run(
    `INSERT OR IGNORE INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)`,
    vaultId,
    "test",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    `INSERT OR IGNORE INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)`,
    deviceId,
    vaultId,
    "test-device",
    "test-token",
  );
}

Deno.test({
  name: "ws - connection is not broadcast to before hello_ack (registered only after hello)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      const hub = new VaultHub(db, dataDir, "test-vault", () => {});
      const fake = makeFakeSocket();
      const p = hub.handleConnection(fake.ws, "dev1");

      // Before hello: connection is not registered, so broadcasts must not reach it.
      hub.broadcast({ type: "server_error", code: "test", message: "pre-ack" });
      assertEquals(fake.sent.length, 0, "no broadcast may reach an unacknowledged connection");

      // Valid hello.
      fake.receive(JSON.stringify({
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        device_id: "dev1",
        last_seen_seq: 0,
        plugin_version: SERVER_VERSION,
      }));
      await new Promise((r) => setTimeout(r, 50));

      // Registered + acknowledged: the first message sent is the hello_ack.
      const first = JSON.parse(fake.sent[0] ?? "{}") as { type: string };
      assertEquals(first.type, "server_hello_ack", "first message after hello must be the ack");

      // Now broadcasts reach the acknowledged connection.
      hub.broadcast({ type: "server_error", code: "test", message: "post-ack" });
      await new Promise((r) => setTimeout(r, 20));
      const msgs = fake.sent.map((s) => JSON.parse(s) as { message?: string });
      assert(
        msgs.some((m) => m.message === "post-ack"),
        "broadcast reaches an acknowledged connection",
      );

      fake.triggerClose();
      await p;
    } finally {
      removeTempDir(dataDir);
    }
  },
});
