import { assertEquals } from "@std/assert";
import { openDb } from "../../server/db.ts";
import { vaultRoutes } from "../../server/routes.ts";
import { SERVER_VERSION } from "../../server/version-gate.ts";

function ensureVaultAndDevice(
  db: ReturnType<typeof openDb>,
  vaultId: string,
  deviceId: string,
): void {
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

Deno.test("GET /version returns the server version", async () => {
  const dir = Deno.makeTempDirSync();
  const db = openDb(dir);
  try {
    const handler = vaultRoutes(db, "test-admin", dir);
    const res = await handler(new Request("http://localhost/version"));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).version, SERVER_VERSION);
  } finally {
    db.close();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
});

Deno.test("GET /vaults/:id/versions/:pathHash includes compacted_range (null default)", async () => {
  const dir = Deno.makeTempDirSync();
  const db = openDb(dir);
  try {
    const vaultId = "vault-1";
    const deviceId = "dev-1";
    const pathHash = "a".repeat(64);
    ensureVaultAndDevice(db, vaultId, deviceId);
    db.run(
      `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at)
       VALUES(?,?,?,?,?,?,?,0,?,?)`,
      vaultId,
      pathHash,
      1,
      1,
      0,
      new Uint8Array([1, 2, 3]),
      JSON.stringify([]),
      deviceId,
      Date.now(),
    );

    const handler = vaultRoutes(db, "test-admin", dir);
    const res = await handler(
      new Request(`http://localhost/vaults/${vaultId}/versions/${pathHash}`, {
        headers: { Authorization: "Bearer test-token" },
      }),
    );
    assertEquals(res.status, 200);
    const chain = (await res.json()) as Array<Record<string, unknown>>;
    assertEquals(chain.length, 1);
    assertEquals(chain[0].compacted_range, null);
  } finally {
    db.close();
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
});
