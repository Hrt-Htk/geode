import { assertEquals } from "@std/assert";
import {
  handleCreateDevice,
  handleCreateVault,
  handleGetVaultInfo,
} from "../../../server/provisioning.ts";
import { handleRenameVault } from "../../../server/admin-vaults.ts";
import { openDb } from "../../../server/db.ts";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

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

const ADMIN_TOKEN = "test-admin";

async function createVaultWithDevice(
  db: Database,
  name: string,
): Promise<{ vaultId: string; token: string }> {
  const createVaultReq = makeReq("http://localhost/vaults", "POST", { name }, ADMIN_TOKEN);
  const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
  assertEquals(createVaultRes.status, 201);
  const vaultBody = await createVaultRes.json() as { vault_id: string };
  const vaultId = vaultBody.vault_id;

  const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
    device_name: "device-A",
  }, ADMIN_TOKEN);
  const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
  assertEquals(createDevRes.status, 201);
  const devBody = await createDevRes.json() as { token: string };

  return { vaultId, token: devBody.token };
}

function vaultName(db: Database, vaultId: string): string {
  const row = db.prepare("SELECT name FROM vaults WHERE id = ?").get(vaultId) as { name: string };
  return row.name;
}

Deno.test({
  name: "vault-rename: happy path: device token renames the vault; change persists",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, token } = await createVaultWithDevice(db, "original-name");

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/name`,
        "PUT",
        { name: "renamed" },
        token,
      );
      const putRes = await handleRenameVault(db, vaultId, putReq);
      assertEquals(putRes.status, 200);
      const body = await putRes.json();
      assertEquals(body.ok, true);

      assertEquals(vaultName(db, vaultId), "renamed", "vault name should persist in DB");

      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as { salt: string; verifier: string | null };
      assertEquals(infoBody.salt !== "", true, "info still returns load-bearing salt");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-rename: empty name → 400",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, token } = await createVaultWithDevice(db, "original-name");

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/name`,
        "PUT",
        { name: "   " },
        token,
      );
      const putRes = await handleRenameVault(db, vaultId, putReq);
      assertEquals(putRes.status, 400);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-rename: name over 64 chars → 400",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, token } = await createVaultWithDevice(db, "original-name");

      const putReq = makeReq(`http://localhost/vaults/${vaultId}/name`, "PUT", {
        name: "x".repeat(65),
      }, token);
      const putRes = await handleRenameVault(db, vaultId, putReq);
      assertEquals(putRes.status, 400);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-rename: no auth → 401",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = await createVaultWithDevice(db, "original-name");

      const putReq = makeReq(`http://localhost/vaults/${vaultId}/name`, "PUT", { name: "renamed" });
      const putRes = await handleRenameVault(db, vaultId, putReq);
      assertEquals(putRes.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-rename: token for a different vault → 403",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = await createVaultWithDevice(db, "vault-a");
      const { token: otherToken } = await createVaultWithDevice(db, "vault-b");

      // vault-a's device token cannot rename vault-b
      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/name`,
        "PUT",
        { name: "hijacked" },
        otherToken,
      );
      const putRes = await handleRenameVault(db, vaultId, putReq);
      assertEquals(putRes.status, 403);
      assertEquals(vaultName(db, vaultId), "vault-a", "name unchanged after forbidden rename");
    } finally {
      removeTempDir(dataDir);
    }
  },
});
