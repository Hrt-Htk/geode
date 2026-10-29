import { handleListDeviceStatus } from "../../../server/admin-vaults.ts";
import { handleCreateDevice, handleCreateVault } from "../../../server/provisioning.ts";
import { setDeviceAppliedSeq } from "../../../server/db.ts";
import { openDb } from "../../../server/db.ts";
import { assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const ADMIN = "test-admin-token";

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

type VaultFixture = { db: Database; vaultId: string; clean: () => void };

async function makeVault(): Promise<VaultFixture> {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  const req = makeReq("http://localhost/vaults", "POST", { name: "test-vault" }, ADMIN);
  const res = await handleCreateVault(db, req, ADMIN);
  assertEquals(res.status, 201);
  const body = await res.json() as { vault_id: string };
  return {
    db,
    vaultId: body.vault_id,
    clean: () => {
      db.close();
      removeTempDir(dataDir);
    },
  };
}

async function mintDevice(
  db: Database,
  vaultId: string,
  name: string,
): Promise<{ deviceId: string; token: string }> {
  const req = makeReq(
    `http://localhost/vaults/${vaultId}/devices`,
    "POST",
    { device_name: name },
    ADMIN,
  );
  const res = await handleCreateDevice(db, vaultId, req, ADMIN);
  assertEquals(res.status, 201);
  const body = await res.json() as { device_id: string; token: string };
  return { deviceId: body.device_id, token: body.token };
}

Deno.test({
  name: "devices-status - device token lists vault devices with applied_seq and head_seq",
  async fn() {
    const f = await makeVault();
    try {
      const d1 = await mintDevice(f.db, f.vaultId, "Laptop");
      await mintDevice(f.db, f.vaultId, "Phone");

      // Author one version so head_seq is non-zero.
      const pathHash = "a".repeat(64);
      f.db.run(
        `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        f.vaultId,
        pathHash,
        1,
        1,
        null,
        new Uint8Array(16),
        "abc123",
        0,
        d1.deviceId,
        Date.now(),
      );

      const req = makeReq(
        `http://localhost/vaults/${f.vaultId}/devices/status`,
        "GET",
        undefined,
        d1.token,
      );
      const res = handleListDeviceStatus(f.db, f.vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as {
        head_seq: number;
        devices: Array<
          { id: string; name: string; last_seen_at: number; applied_seq: number | null }
        >;
      };
      assertEquals(body.head_seq, 1);
      assertEquals(body.devices.length, 2);
      const phone = body.devices.find((d) => d.name === "Phone");
      assertEquals(phone !== undefined, true);
      assertEquals(phone!.applied_seq, null, "fresh device applied_seq is null (never reported)");
      assertEquals(typeof phone!.last_seen_at, "number");
      const laptop = body.devices.find((d) => d.name === "Laptop");
      assertEquals(laptop !== undefined, true);
      assertEquals(laptop!.applied_seq, null);
    } finally {
      f.clean();
    }
  },
});

Deno.test({
  name:
    "devices-status - head_seq reflects the vault max seq; applied_seq reports the stored value",
  async fn() {
    const f = await makeVault();
    try {
      const d1 = await mintDevice(f.db, f.vaultId, "Laptop");
      await mintDevice(f.db, f.vaultId, "Phone");

      // Author two versions (head_seq 2) and set Laptop's applied_seq to 1.
      for (let i = 1; i <= 2; i++) {
        f.db.run(
          `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          f.vaultId,
          `${String(i).repeat(64)}`,
          i,
          i,
          i === 1 ? null : i - 1,
          new Uint8Array(16),
          "abc123",
          0,
          d1.deviceId,
          Date.now(),
        );
      }
      setDeviceAppliedSeq(f.db, d1.deviceId, 1);

      const req = makeReq(
        `http://localhost/vaults/${f.vaultId}/devices/status`,
        "GET",
        undefined,
        d1.token,
      );
      const res = handleListDeviceStatus(f.db, f.vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as {
        head_seq: number;
        devices: Array<{ id: string; name: string; applied_seq: number | null }>;
      };
      assertEquals(body.head_seq, 2);
      const laptop = body.devices.find((d) => d.id === d1.deviceId);
      assertEquals(laptop!.applied_seq, 1);
      const phone = body.devices.find((d) => d.name === "Phone");
      assertEquals(phone!.applied_seq, null, "unreported device stays null");
    } finally {
      f.clean();
    }
  },
});

Deno.test({
  name: "devices-status - device token from a DIFFERENT vault is rejected (403)",
  async fn() {
    const f = await makeVault();
    try {
      // Second vault in the SAME database so the foreign token exists but is
      // vault-mismatched (the reviewer's scoping check: a valid device token
      // may only list its OWN vault).
      const vault2req = makeReq("http://localhost/vaults", "POST", { name: "other" }, ADMIN);
      const vault2res = await handleCreateVault(f.db, vault2req, ADMIN);
      assertEquals(vault2res.status, 201);
      const vault2 = (await vault2res.json() as { vault_id: string }).vault_id;
      const d2 = await mintDevice(f.db, vault2, "Other");

      const req = makeReq(
        `http://localhost/vaults/${f.vaultId}/devices/status`,
        "GET",
        undefined,
        d2.token,
      );
      const res = handleListDeviceStatus(f.db, f.vaultId, req);
      assertEquals(res.status, 403);
      const body = await res.json() as { error: string };
      assertEquals(body.error, "vault mismatch");
    } finally {
      f.clean();
    }
  },
});

Deno.test({
  name: "devices-status - no token returns 401",
  async fn() {
    const f = await makeVault();
    try {
      await mintDevice(f.db, f.vaultId, "Laptop");
      const req = makeReq(`http://localhost/vaults/${f.vaultId}/devices/status`, "GET");
      const res = handleListDeviceStatus(f.db, f.vaultId, req);
      assertEquals(res.status, 401);
    } finally {
      f.clean();
    }
  },
});

Deno.test({
  name: "devices-status - revoked devices are excluded",
  async fn() {
    const f = await makeVault();
    try {
      const d1 = await mintDevice(f.db, f.vaultId, "Laptop");
      const d2 = await mintDevice(f.db, f.vaultId, "Revoked");

      f.db.run(
        "UPDATE devices SET token = ? WHERE id = ?",
        `revoked:${crypto.randomUUID()}`,
        d2.deviceId,
      );

      const req = makeReq(
        `http://localhost/vaults/${f.vaultId}/devices/status`,
        "GET",
        undefined,
        d1.token,
      );
      const res = handleListDeviceStatus(f.db, f.vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as {
        devices: Array<{ id: string; name: string }>;
      };
      assertEquals(body.devices.length, 1);
      assertEquals(body.devices[0].name, "Laptop");
    } finally {
      f.clean();
    }
  },
});
