import { assert, assertEquals } from "@std/assert";
import { insertVersion, openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { getTrashedHead, trashHead } from "../../../server/trash-db.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

// Dispatch oracle: exercises the vaultRoutes route table end-to-end for the
// routes not otherwise driven through dispatch in other tests (info, device
// list, vault rename, purge-all, 404s). Refactor guard: must stay green.

const ADMIN = "test-admin-token";

function setup(
  db: ReturnType<typeof openDb>,
): { vaultId: string; deviceId: string; token: string } {
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "tok-" + crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return { vaultId, deviceId, token };
}

function makeReq(url: string, method: string, body?: unknown, auth?: string): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  if (auth) {
    init.headers = { ...(init.headers as Record<string, string>), authorization: `Bearer ${auth}` };
  }
  return new Request(url, init);
}

Deno.test({
  name: "dispatch - GET /vaults/:id/info (admin) returns salt",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      const res = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/info`, "GET", undefined, ADMIN),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { salt: string; verifier: string | null };
      assertEquals(typeof body.salt, "string");
      assertEquals(body.salt.length > 0, true);
      assertEquals(body.verifier, null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "dispatch - GET /vaults/:id/devices (admin) lists the device",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, deviceId } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      const res = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/devices`, "GET", undefined, ADMIN),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as Array<{ id: string; name: string }>;
      assertEquals(body.length, 1);
      assertEquals(body[0].id, deviceId);
      assertEquals(body[0].name, "test-device");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "dispatch - PUT /vaults/:id/name (device) persists the rename",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, token } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      const res = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/name`, "PUT", { name: "renamed" }, token),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assertEquals(body.ok, true);

      const row = db.prepare("SELECT name FROM vaults WHERE id = ?").get(vaultId) as
        | { name: string }
        | null;
      assertEquals(row?.name, "renamed");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "dispatch - POST /vaults/:id/trash/purge-all (admin) empties trash",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, deviceId } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      insertVersion(db, vaultId, "a".repeat(64), 0, new Uint8Array([1]), [], false, deviceId);
      trashHead(db, vaultId, "a".repeat(64), 1, deviceId);
      assert(getTrashedHead(db, vaultId, "a".repeat(64)) !== null, "trash seeded");

      const res = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/trash/purge-all`, "POST", null, ADMIN),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { purged: number };
      assertEquals(body.purged, 1);
      assertEquals(getTrashedHead(db, vaultId, "a".repeat(64)), null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "dispatch - unknown path returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      const res = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/nope`, "GET", undefined, ADMIN),
      );
      assertEquals(res.status, 404);
      const res2 = await handler(makeReq("http://localhost/version/extra", "GET"));
      assertEquals(res2.status, 404);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "dispatch - known path with wrong method returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, token } = setup(db);
      const handler = vaultRoutes(db, ADMIN, dataDir);

      // GET /version is registered; POST /version is not.
      const res = await handler(makeReq("http://localhost/version", "POST"));
      assertEquals(res.status, 404);

      // HEAD /vaults is not registered.
      const res2 = await handler(
        makeReq(`http://localhost/vaults/${vaultId}/heads`, "HEAD", undefined, token),
      );
      assertEquals(res2.status, 404);
    } finally {
      removeTempDir(dataDir);
    }
  },
});
