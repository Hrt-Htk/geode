import { assert, assertEquals } from "@std/assert";
import { fsUsage } from "../../../server/fs-usage.ts";
import { putBlob } from "../../../server/blobs.ts";
import { measureVault } from "../../../server/vault-budget.ts";
import { openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const ADMIN = "test-admin";

function setup(db: ReturnType<typeof openDb>): { vaultId: string; token: string } {
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "tok-" + crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "storage-vault",
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
  return { vaultId, token };
}

function makeReq(url: string, auth?: string): Request {
  const init: RequestInit = { method: "GET" };
  if (auth) init.headers = { authorization: `Bearer ${auth}` };
  return new Request(url, init);
}

Deno.test("fsUsage: real statvfs of a temp dir", () => {
  const dir = makeTempDataDir();
  try {
    const { total, free, used } = fsUsage(dir);
    assert(total > 0, "total > 0");
    assert(free > 0, "free > 0");
    assert(total >= free, "total >= free");
    assert(used >= 0, "used >= 0");
    assert(free + used <= total, "free + used <= total");
  } finally {
    removeTempDir(dir);
  }
});

Deno.test("storage route: valid device token → 200 with byte counts", async () => {
  const dataDir = makeTempDataDir();
  try {
    const db = openDb(dataDir);
    const { vaultId, token } = setup(db);
    const handler = vaultRoutes(db, ADMIN, dataDir);

    const res = await handler(makeReq(`http://localhost/vaults/${vaultId}/storage`, token));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      total: number;
      free: number;
      used: number;
      vault_used: number;
    };
    assert(typeof body.total === "number" && body.total > 0, "total is a positive number");
    assert(typeof body.free === "number" && body.free > 0, "free is a positive number");
    assert(typeof body.used === "number" && body.used >= 0, "used is a non-negative number");
    assert(body.total >= body.free, "total >= free");
    assertEquals(body.vault_used, 0, "no blobs yet → vault_used is 0");
  } finally {
    removeTempDir(dataDir);
  }
});

Deno.test("storage route: vault_used reads this vault's counter", async () => {
  const dataDir = makeTempDataDir();
  try {
    const db = openDb(dataDir);
    const { vaultId, token } = setup(db);
    const other = setup(db);
    const handler = vaultRoutes(db, ADMIN, dataDir);

    const h1 = "a".repeat(64);
    const h2 = "b".repeat(64);
    await putBlob(dataDir, vaultId, h1, new Uint8Array(1000));
    await putBlob(dataDir, vaultId, h2, new Uint8Array(2500));
    // A foreign vault's blob and an in-flight .tmp file must not count.
    await putBlob(dataDir, other.vaultId, "c".repeat(64), new Uint8Array(9999));
    await Deno.writeTextFile(
      `${dataDir}/blobs/${vaultId}/aa/${h1.slice(2)}.tmp-deadbeef`,
      "x".repeat(777),
    );
    // The counter is measured at startup and kept by the writers; the route reads it.
    assertEquals(measureVault(db, dataDir, vaultId), 3500);

    const res = await handler(makeReq(`http://localhost/vaults/${vaultId}/storage`, token));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { vault_used: number };
    assertEquals(body.vault_used, 3500);
  } finally {
    removeTempDir(dataDir);
  }
});

Deno.test("storage route: missing token → 401, unknown token → 401", async () => {
  const dataDir = makeTempDataDir();
  try {
    const db = openDb(dataDir);
    const { vaultId } = setup(db);
    const handler = vaultRoutes(db, ADMIN, dataDir);

    assertEquals(
      (await handler(makeReq(`http://localhost/vaults/${vaultId}/storage`))).status,
      401,
    );
    assertEquals(
      (await handler(makeReq(`http://localhost/vaults/${vaultId}/storage`, "bogus"))).status,
      401,
    );
  } finally {
    removeTempDir(dataDir);
  }
});

Deno.test("storage route: token for a different vault → 403", async () => {
  const dataDir = makeTempDataDir();
  try {
    const db = openDb(dataDir);
    const a = setup(db);
    const b = setup(db);
    const handler = vaultRoutes(db, ADMIN, dataDir);

    const res = await handler(makeReq(`http://localhost/vaults/${a.vaultId}/storage`, b.token));
    assertEquals(res.status, 403);
  } finally {
    removeTempDir(dataDir);
  }
});
