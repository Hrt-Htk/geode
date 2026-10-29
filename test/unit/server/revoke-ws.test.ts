import { handleRevokeDevice } from "../../../server/admin-vaults.ts";
import { getHub } from "../../../server/ws.ts";
import { openDb } from "../../../server/db.ts";
import { b64encode } from "../../../core/protocol.ts";
import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const ADMIN = "test-admin-token";

function createVault(db: Database): { vaultId: string } {
  const vaultId = crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id,name,salt,created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    new Uint8Array(16),
    Date.now(),
  );
  return { vaultId };
}

function createDevice(db: Database, vaultId: string): { deviceId: string } {
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64encode(tokenBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  db.run(
    "INSERT INTO devices(id,vault_id,name,token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return { deviceId };
}

function makeReq(url: string, method: string, auth?: string): Request {
  const init: RequestInit = { method };
  if (auth) init.headers = { authorization: `Bearer ${auth}` };
  return new Request(url, init);
}

Deno.test({
  name: "admin-vaults - revoke closes the revoked device's live WebSocket",
  fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      // Register a live connection for this device in the vault hub.
      const hub = getHub(db, dataDir, vaultId);
      let closed = false;
      const fakeWs = {
        send: () => {},
        close: () => {
          closed = true;
        },
        bufferedAmount: 0,
      } as unknown as WebSocket;
      hub.register(fakeWs, deviceId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}`,
        "DELETE",
        ADMIN,
      );
      const res = handleRevokeDevice(db, vaultId, deviceId, req, ADMIN);
      assertEquals(res.status, 200);

      assert(
        closed,
        "revoking a device must close its live WebSocket via the vault hub",
      );
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
