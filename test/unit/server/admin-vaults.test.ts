import {
  handleListDevices,
  handleListDeviceStatus,
  handleListVaults,
  handleRenameDevice,
  handleRevokeDevice,
} from "../../../server/admin-vaults.ts";
import { handleCreateDevice, handleCreateVault } from "../../../server/provisioning.ts";
import { validateToken } from "../../../server/auth.ts";
import { openDb } from "../../../server/db.ts";
import { b64encode } from "../../../core/protocol.ts";
import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const ADMIN = "test-admin-token";

function createVault(db: Database): { vaultId: string; salt: string } {
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(salt);
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );
  return { vaultId, salt: saltB64 };
}

function createDevice(db: Database, vaultId: string): { deviceId: string; token: string } {
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64encode(tokenBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return { deviceId, token };
}

function makeReq(url: string, method: string, body?: unknown, auth?: string): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  if (auth) {
    init.headers = { ...init.headers, authorization: `Bearer ${auth}` };
  }
  return new Request(url, init);
}

// ── handleListVaults ──────────────────────────────────────────────────

Deno.test({
  name: "admin-vaults - GET /vaults returns the stored millisecond created_at",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const createdAt = 1793274515248;
      db.run(
        "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
        "v-ms",
        "test-vault",
        new Uint8Array(16),
        createdAt,
      );
      const res = handleListVaults(
        db,
        makeReq("http://localhost/vaults", "GET", undefined, ADMIN),
        ADMIN,
      );
      const body = await res.json() as Array<{ id: string; created_at: number }>;
      assertEquals(body.find((v) => v.id === "v-ms")?.created_at, createdAt);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - GET /vaults with admin returns 200 with vault list",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId: v1 } = createVault(db);
      const { vaultId: v2 } = createVault(db);
      createDevice(db, v1);
      createDevice(db, v1);
      createDevice(db, v2);

      const req = makeReq("http://localhost/vaults", "GET", undefined, ADMIN);
      const res = handleListVaults(db, req, ADMIN);
      assertEquals(res.status, 200);

      const body = await res.json() as Array<{
        id: string;
        name: string;
        device_count: number;
        created_at: number;
        last_seen_at: number;
      }>;
      assertEquals(body.length, 2);

      const v1Entry = body.find((v) => v.id === v1);
      assert(v1Entry);
      assertEquals(v1Entry.device_count, 2);
      assertEquals(typeof v1Entry.last_seen_at, "number");

      const v2Entry = body.find((v) => v.id === v2);
      assert(v2Entry);
      assertEquals(v2Entry.device_count, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - GET /vaults without auth returns 401",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      createVault(db);

      const req = makeReq("http://localhost/vaults", "GET");
      const res = handleListVaults(db, req, ADMIN);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - GET /vaults with wrong token returns 401",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      createVault(db);

      const req = makeReq("http://localhost/vaults", "GET", undefined, "wrong-token");
      const res = handleListVaults(db, req, ADMIN);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── handleListDevices ─────────────────────────────────────────────────

Deno.test({
  name: "admin-vaults - GET /vaults/:id/devices with admin returns 200",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId: d1 } = createDevice(db, vaultId);
      const { deviceId: d2 } = createDevice(db, vaultId);

      const req = makeReq(`http://localhost/vaults/${vaultId}/devices`, "GET", undefined, ADMIN);
      const res = handleListDevices(db, vaultId, req, ADMIN);
      assertEquals(res.status, 200);

      const body = await res.json() as Array<{
        id: string;
        name: string;
        last_seen_at: number;
        plugin_version: string;
      }>;
      assertEquals(body.length, 2);
      assert(body.some((d) => d.id === d1));
      assert(body.some((d) => d.id === d2));
      assert(typeof body[0].id === "string");
      assert(typeof body[0].name === "string");
      assert(typeof body[0].last_seen_at === "number");
      assert(typeof body[0].plugin_version === "string");
      assert(
        !("created_at" in body[0]),
        "device row must not expose dead created_at",
      );
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - GET /vaults/:id/devices without auth returns 401",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);

      const req = makeReq(`http://localhost/vaults/${vaultId}/devices`, "GET");
      const res = handleListDevices(db, vaultId, req, ADMIN);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── handleRevokeDevice ────────────────────────────────────────────────

Deno.test({
  name: "admin-vaults - DELETE revokes device so its token stops validating",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);

      // The token validates while the device row exists.
      const info = validateToken(db, token);
      assert(info);
      assertEquals(info.device_id, deviceId);

      // Revoke
      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}`,
        "DELETE",
        undefined,
        ADMIN,
      );
      const res = handleRevokeDevice(db, vaultId, deviceId, req, ADMIN);
      assertEquals(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assertEquals(body.ok, true);

      // The revoked token no longer validates.
      const after = validateToken(db, token);
      assertEquals(after, null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - DELETE without auth returns 401",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}`,
        "DELETE",
      );
      const res = handleRevokeDevice(db, vaultId, deviceId, req, ADMIN);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - DELETE nonexistent device returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/nonexistent-id`,
        "DELETE",
        undefined,
        ADMIN,
      );
      const res = handleRevokeDevice(db, vaultId, "nonexistent-id", req, ADMIN);
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "device not found");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── handleRevokeDevice: soft revoke with authored versions ───────────

Deno.test({
  name:
    "admin-vaults - DELETE revoked device with authored file_versions returns 200, token invalid, history preserved",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);

      // Author some file_versions rows (this triggers the FK constraint on DELETE)
      const pathHash = crypto.getRandomValues(new Uint8Array(32));
      db.run(
        `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        vaultId,
        pathHash,
        1,
        1,
        null,
        new Uint8Array(16),
        "abc123",
        0,
        deviceId,
        Date.now(),
      );
      db.run(
        `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        vaultId,
        pathHash,
        2,
        2,
        1,
        new Uint8Array(16),
        "def456",
        0,
        deviceId,
        Date.now(),
      );

      // The token validates while the device row exists.
      const info = validateToken(db, token);
      assert(info);
      assertEquals(info.device_id, deviceId);

      // Revoke: should return 200, NOT 500
      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}`,
        "DELETE",
        undefined,
        ADMIN,
      );
      const res = handleRevokeDevice(db, vaultId, deviceId, req, ADMIN);
      assertEquals(res.status, 200);

      // The revoked token no longer validates.
      const after = validateToken(db, token);
      assertEquals(after, null);

      // file_versions rows should still exist (FK preserved)
      const fvCount = db.prepare(
        "SELECT COUNT(*) AS cnt FROM file_versions WHERE device_id = ?",
      ).get(deviceId) as { cnt: number };
      assertEquals(fvCount.cnt, 2, "file_versions rows must be preserved after revoke");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── handleRenameDevice (device-token only, self-only) ─────────────────

Deno.test({
  name: "admin-vaults - PUT /name with own device token renames device",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        "PUT",
        { name: "New Name" },
        token,
      );
      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { ok: boolean };
      assertEquals(body.ok, true);

      const row = db.prepare("SELECT name FROM devices WHERE id = ?").get(deviceId) as {
        name: string;
      };
      assertEquals(row.name, "New Name");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - PUT /name without token returns 401",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        "PUT",
        { name: "New Name" },
      );
      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - PUT /name with invalid token returns 401",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        "PUT",
        { name: "New Name" },
        "totally-invalid-token",
      );
      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - PUT /name with own token on DIFFERENT device returns 403",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { token: aToken } = createDevice(db, vaultId);
      const { deviceId: b } = createDevice(db, vaultId);

      // A tries to rename B using A's token → self-only gate must forbid
      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${b}/name`,
        "PUT",
        { name: "Hijacked" },
        aToken,
      );
      const res = await handleRenameDevice(db, vaultId, b, req);
      assertEquals(res.status, 403);

      // B's name unchanged
      const row = db.prepare("SELECT name FROM devices WHERE id = ?").get(b) as { name: string };
      assertEquals(row.name, "test-device");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - PUT /name with admin token returns 401 (no admin path)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        "PUT",
        { name: "Admin Rename" },
        ADMIN,
      );
      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - PUT /name with empty name returns 400",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        "PUT",
        { name: "   " },
        token,
      );
      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 400);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "invalid name");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - a device row deleted while the body is read returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);

      // The gate reads the live row; `readJson` then awaits the body, which is where a
      // concurrent delete lands. The handler must report not-found, not rename nothing.
      let deleted = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (!deleted) {
            deleted = true;
            db.run("DELETE FROM devices WHERE id = ?", deviceId);
          }
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "New Name" })));
          controller.close();
        },
      });
      const req = new Request(
        `http://localhost/vaults/${vaultId}/devices/${deviceId}/name`,
        {
          method: "PUT",
          body: stream,
          duplex: "half",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        } as RequestInit,
      );

      const res = await handleRenameDevice(db, vaultId, deviceId, req);
      assertEquals(res.status, 404);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "device not found");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── handleCreateDevice includes salt + verifier ───────────────────────

Deno.test({
  name: "provisioning - handleCreateDevice includes salt and verifier",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault via handler
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "test-vault" },
        ADMIN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string };

      // Create device via handler
      const createDeviceReq = makeReq(
        `http://localhost/vaults/${vaultBody.vault_id}/devices`,
        "POST",
        { device_name: "my-device" },
        ADMIN,
      );
      const createDeviceRes = await handleCreateDevice(
        db,
        vaultBody.vault_id,
        createDeviceReq,
        ADMIN,
      );
      assertEquals(createDeviceRes.status, 201);
      const deviceBody = await createDeviceRes.json() as {
        device_id: string;
        token: string;
        salt: string;
        verifier: string | null;
      };
      assert(deviceBody.device_id);
      assert(deviceBody.token);
      assert(deviceBody.salt, "salt should be truthy");
      assertEquals(typeof deviceBody.salt, "string");
      assert(typeof deviceBody.verifier === "string" || deviceBody.verifier === null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── the retired restore pseudo device (#687) ──────────────────────────

/** The row migration 016 flags: a legacy `geode-trash-restore` device. It authored
 * versions (history keeps it, the FK needs it) but is not a device the user has. */
function createRestoreDevice(db: Database, vaultId: string): string {
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO devices(id, vault_id, name, token, is_restore) VALUES(?,?,?,?,1)",
    id,
    vaultId,
    "geode-trash-restore",
    `restore-token-${id}`,
  );
  return id;
}

Deno.test({
  name: "admin-vaults - device lists and counts exclude the retired restore device",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const restoreId = createRestoreDevice(db, vaultId);

      const vaults = await handleListVaults(
        db,
        makeReq("http://localhost/vaults", "GET", undefined, ADMIN),
        ADMIN,
      ).json() as Array<{ id: string; device_count: number }>;
      assertEquals(
        vaults.find((v) => v.id === vaultId)!.device_count,
        1,
        "count is real devices only",
      );

      const devices = await handleListDevices(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/devices`, "GET", undefined, ADMIN),
        ADMIN,
      ).json() as Array<{ id: string }>;
      assertEquals(devices.map((d) => d.id), [deviceId]);

      const status = await handleListDeviceStatus(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/devices/status`, "GET", undefined, token),
      ).json() as { devices: Array<{ id: string }> };
      assertEquals(status.devices.map((d) => d.id), [deviceId], "the Devices view hides it");
      assert(!status.devices.some((d) => d.id === restoreId));
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - revoking the retired restore device is refused",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const restoreId = createRestoreDevice(db, vaultId);

      const res = handleRevokeDevice(
        db,
        vaultId,
        restoreId,
        makeReq(
          `http://localhost/vaults/${vaultId}/devices/${restoreId}`,
          "DELETE",
          undefined,
          ADMIN,
        ),
        ADMIN,
      );
      assertEquals(res.status, 403);
      const row = db.prepare("SELECT token FROM devices WHERE id = ?").get(restoreId) as {
        token: string;
      };
      assertEquals(row.token.startsWith("revoked:"), false, "the row keeps its token");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "admin-vaults - renaming the retired restore device is refused",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const restoreId = createRestoreDevice(db, vaultId);
      const row = db.prepare("SELECT token FROM devices WHERE id = ?").get(restoreId) as {
        token: string;
      };

      const res = await handleRenameDevice(
        db,
        vaultId,
        restoreId,
        makeReq(
          `http://localhost/vaults/${vaultId}/devices/${restoreId}/name`,
          "PUT",
          { name: "My laptop" },
          row.token,
        ),
      );
      assertEquals(res.status, 403);
      const after = db.prepare("SELECT name FROM devices WHERE id = ?").get(restoreId) as {
        name: string;
      };
      assertEquals(after.name, "geode-trash-restore");
    } finally {
      removeTempDir(dataDir);
    }
  },
});
