import { assertEquals, assertNotEquals } from "@std/assert";
import {
  handleCreateDevice,
  handleCreateVault,
  handleGetVaultInfo,
  handlePutVerifier,
} from "../../../server/provisioning.ts";
import { attachRemoteAddr } from "../../../server/http-helpers.ts";
import { resetRateLimits } from "../../../server/rate-limit.ts";
import { openDb } from "../../../server/db.ts";
import { checkVerifier, deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64decode, b64encode } from "../../../core/protocol.ts";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function makeReq(
  url: string,
  method: string,
  body?: unknown,
  auth?: string,
  admin?: string,
): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  if (auth) {
    init.headers = { ...init.headers, authorization: `Bearer ${auth}` };
  }
  if (admin) {
    init.headers = { ...init.headers, "x-geode-admin-token": admin };
  }
  return new Request(url, init);
}

function countDevices(db: Database, vaultId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM devices WHERE vault_id = ?",
  ).get(vaultId) as { n: number };
  return row.n;
}

const ADMIN_TOKEN = "test-admin";
const PASSPHRASE = "test";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// The pre-#298 defaults: kept as a fixture because a stored pair stays valid.
const LEGACY_OPS = 2;
const LEGACY_MEM = 65536;

Deno.test({
  name: "vault-info: GET /vaults/:id/info returns salt+verifier without creating a device",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "test-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      // Device A: create, derive keys, set verifier
      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as {
          device_id: string;
          token: string;
          salt: string;
        };
        return { deviceId: devBody.device_id, token: devBody.token };
      })();

      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      await (async () => {
        const putReq = makeReq(
          `http://localhost/vaults/${vaultId}/verifier`,
          "PUT",
          { verifier: verifierB64 },
          tokenA,
          ADMIN_TOKEN,
        );
        const putRes = await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN);
        assertEquals(putRes.status, 200);
      })();

      // Device count after A: 1
      assertEquals(countDevices(db, vaultId), 1, "device count should be 1 after device-A");

      // Call handleGetVaultInfo: should NOT create a device
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as { salt: string; verifier: string | null };
      assertNotEquals(infoBody.salt, "", "salt should be present");
      assertEquals(infoBody.verifier, verifierB64, "verifier should match what A set");

      // CRITICAL: device count unchanged
      assertEquals(countDevices(db, vaultId), 1, "getVaultInfo must not create a device");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: wrong passphrase fails verifier without orphaning a device",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "bad-pw-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      // Device A sets verifier
      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64 },
        tokenA,
        ADMIN_TOKEN,
      );
      const putRes = await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN);
      assertEquals(putRes.status, 200);

      // Device count: 1
      assertEquals(countDevices(db, vaultId), 1);

      // --- Simulate the fixed joinWithAdminFlow logic ---
      // 1. getVaultInfo (no device created)
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as { salt: string; verifier: string | null };
      assertEquals(countDevices(db, vaultId), 1, "still 1 after getVaultInfo");

      // 2. derive keys with WRONG passphrase
      const keysWrong = await deriveKeys("wrong-passphrase", b64decode(infoBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierOk = await checkVerifier(keysWrong, b64decode(infoBody.verifier!));
      assertEquals(verifierOk, false, "wrong passphrase should fail verifier");

      // 3. The flow would throw here: no device created yet
      // Device count must still be 1
      assertEquals(
        countDevices(db, vaultId),
        1,
        "wrong passphrase must not create orphaned device",
      );

      // 4. Now try with CORRECT passphrase: should succeed
      const keysCorrect = await deriveKeys(PASSPHRASE, b64decode(infoBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierOkCorrect = await checkVerifier(keysCorrect, b64decode(infoBody.verifier!));
      assertEquals(verifierOkCorrect, true, "correct passphrase should pass");

      // Create device AFTER verification passes
      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-B",
      }, ADMIN_TOKEN);
      const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
      assertEquals(createDevRes.status, 201);

      // Device count is now 2
      assertEquals(countDevices(db, vaultId), 2, "correct passphrase + createDevice → count is 2");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: no verifier case: getVaultInfo returns null verifier",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault with no verifier set
      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "no-verifier-vault",
      }, ADMIN_TOKEN);
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as { salt: string; verifier: string | null };
      assertEquals(infoBody.verifier, null, "no verifier set → null");
      assertEquals(countDevices(db, vaultId), 0, "still no devices created");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: nonexistent vault returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const fakeVaultId = crypto.randomUUID();

      const infoReq = makeReq(
        `http://localhost/vaults/${fakeVaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, fakeVaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 404);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: unauthenticated request returns 401",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "auth-test-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string };
      const vaultId = vaultBody.vault_id;

      // No admin token
      const infoReq = makeReq(`http://localhost/vaults/${vaultId}/info`, "GET");
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: PUT /verifier with argon2 params persists them; GET returns them",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault + device
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "params-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      // Derive keys and set verifier WITH params
      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64, argon2_ops: 3, argon2_mem: 67108864 },
        tokenA,
        ADMIN_TOKEN,
      );
      const putRes = await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN);
      assertEquals(putRes.status, 200);

      // GET /info should return the stored params
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      assertEquals(infoBody.argon2_ops, 3);
      assertEquals(infoBody.argon2_mem, 67108864);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: legacy vault (params NULL) returns null argon2 params",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault + device, set verifier WITHOUT params (simulates pre-#298 vault)
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "legacy-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      // PUT verifier WITHOUT params
      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64 },
        tokenA,
        ADMIN_TOKEN,
      );
      const putRes = await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN);
      assertEquals(putRes.status, 200);

      // GET /info should return null for params
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes = await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN);
      assertEquals(infoRes.status, 200);
      const infoBody = await infoRes.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      assertEquals(infoBody.argon2_ops, null);
      assertEquals(infoBody.argon2_mem, null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: legacy vault self-heal: PUT legacy params then GET returns them",
  async fn() {
    // Simulates the fixed join-admin self-heal: legacy vault (NULL params) gets
    // backfilled with legacy params via putVerifier, then a subsequent GET returns
    // those params so the next device derives the correct content_key.
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault + device
      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "legacy-backfill-vault",
      }, ADMIN_TOKEN);
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      // Set verifier WITHOUT params (simulates pre-#298 legacy vault).
      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      const putReqNoParams = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64 },
        tokenA,
        ADMIN_TOKEN,
      );
      const putResNoParams = await handlePutVerifier(db, vaultId, putReqNoParams, ADMIN_TOKEN);
      assertEquals(putResNoParams.status, 200);

      // Verify server still has NULL params.
      const infoReq1 = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes1 = await handleGetVaultInfo(db, vaultId, infoReq1, ADMIN_TOKEN);
      const infoBody1 = await infoRes1.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      assertEquals(infoBody1.argon2_ops, null);
      assertEquals(infoBody1.argon2_mem, null);

      // Simulate the fixed self-heal: PUT verifier WITH params. A backfill installs a
      // *new* pair, so it must sit in band, and it runs on a set verifier, so it
      // needs no admin token (device-only, unlike the first write).
      const BACKFILL_OPS = 2;
      const BACKFILL_MEM = 16 * MIB;
      const putReqLegacy = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64, argon2_ops: BACKFILL_OPS, argon2_mem: BACKFILL_MEM },
        tokenA,
      );
      const putResLegacy = await handlePutVerifier(db, vaultId, putReqLegacy, ADMIN_TOKEN);
      assertEquals(putResLegacy.status, 200);

      // GET /info should now return the backfilled legacy params.
      const infoReq2 = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoRes2 = await handleGetVaultInfo(db, vaultId, infoReq2, ADMIN_TOKEN);
      assertEquals(infoRes2.status, 200);
      const infoBody2 = await infoRes2.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      assertEquals(infoBody2.argon2_ops, BACKFILL_OPS, "backfilled ops should persist");
      assertEquals(infoBody2.argon2_mem, BACKFILL_MEM, "backfilled mem should persist");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: PUT /verifier with a different verifier → 409 and stored verifier unchanged",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "overwrite-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifierA = b64encode(await makeVerifier(keysA));
      const keysB = await deriveKeys("different", saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifierB = b64encode(await makeVerifier(keysB));

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA },
        tokenA,
        ADMIN_TOKEN,
      );
      assertEquals((await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN)).status, 200);

      // Attempt to overwrite with a different verifier → 409, stored value unchanged.
      const overwriteReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB },
        tokenA,
        ADMIN_TOKEN,
      );
      const overwriteRes = await handlePutVerifier(db, vaultId, overwriteReq, ADMIN_TOKEN);
      assertEquals(overwriteRes.status, 409);

      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoBody = await (await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN))
        .json() as { verifier: string | null };
      assertEquals(infoBody.verifier, verifierA, "stored verifier must be unchanged");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: re-PUT identical verifier → 200 (idempotent retry)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "idempotent-vault",
      }, ADMIN_TOKEN);
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const keysA = await deriveKeys(PASSPHRASE, b64decode(vaultBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierA = b64encode(await makeVerifier(keysA));

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA },
        tokenA,
        ADMIN_TOKEN,
      );
      assertEquals((await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN)).status, 200);
      // Identical retry → idempotent success (fresh request, body not yet consumed).
      const retryReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA },
        tokenA,
        ADMIN_TOKEN,
      );
      const retryRes = await handlePutVerifier(db, vaultId, retryReq, ADMIN_TOKEN);
      assertEquals(retryRes.status, 200);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #675: the params a client installs bound every device's Argon2 allocation:
// outside the band is a 400, and nothing is stored.
Deno.test({
  name: "vault-info: PUT /verifier rejects out-of-band argon2 params with 400",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "band-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-A",
      }, ADMIN_TOKEN);
      const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
      const devBody = await createDevRes.json() as { token: string };

      const keysA = await deriveKeys(PASSPHRASE, b64decode(vaultBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifier = b64encode(await makeVerifier(keysA));
      const put = (body: unknown) =>
        handlePutVerifier(
          db,
          vaultId,
          makeReq(
            `http://localhost/vaults/${vaultId}/verifier`,
            "PUT",
            body,
            devBody.token,
            ADMIN_TOKEN,
          ),
          ADMIN_TOKEN,
        );

      for (const [ops, mem] of [[0, 64 * MIB], [11, 64 * MIB], [3, 8 * MIB - 1], [3, GIB + 1]]) {
        assertEquals(
          (await put({ verifier, argon2_ops: ops, argon2_mem: mem })).status,
          400,
          `ops ${ops} / mem ${mem} must be refused`,
        );
      }
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoBody = await (await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN))
        .json() as {
          verifier: string | null;
          argon2_ops: number | null;
          argon2_mem: number | null;
        };
      assertEquals(infoBody.verifier, null, "a refused write must not store the verifier");
      assertEquals(infoBody.argon2_ops, null);
      assertEquals(infoBody.argon2_mem, null);

      // The band edges stay valid.
      assertEquals((await put({ verifier, argon2_ops: 3, argon2_mem: 8 * MIB })).status, 200);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #675: `PUT /verifier` while the column is NULL is the same trust-on-first-use
// hole as the auth hash: write-once, so whoever writes first locks everyone out.
Deno.test({
  name: "vault-info: PUT /verifier needs the admin token while the verifier is NULL",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "tofu-verifier-vault",
      }, ADMIN_TOKEN);
      const vaultBody = await (await handleCreateVault(db, createVaultReq, ADMIN_TOKEN)).json() as {
        vault_id: string;
        salt: string;
      };
      const vaultId = vaultBody.vault_id;
      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-A",
      }, ADMIN_TOKEN);
      const devBody = await (await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN))
        .json() as { token: string };

      const keysA = await deriveKeys(PASSPHRASE, b64decode(vaultBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const attackerVerifier = b64encode(await makeVerifier(keysA));
      const put = (admin?: string) =>
        handlePutVerifier(
          db,
          vaultId,
          makeReq(
            `http://localhost/vaults/${vaultId}/verifier`,
            "PUT",
            { verifier: attackerVerifier, argon2_ops: 3, argon2_mem: 64 * MIB },
            devBody.token,
            admin,
          ),
          admin,
        );

      // A stolen device token alone must not be able to claim the verifier.
      assertEquals((await put()).status, 403);
      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoBody = await (await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN))
        .json() as {
          verifier: string | null;
          argon2_ops: number | null;
        };
      assertEquals(infoBody.verifier, null, "a device token alone must not write the verifier");
      assertEquals(infoBody.argon2_ops, null);

      // Device token + admin token writes it.
      assertEquals((await put(ADMIN_TOKEN)).status, 200);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #675: the band binds a *change*: a vault whose stored params predate it (the
// old default ops 2 / 64 KiB) keeps working when a client re-sends them.
Deno.test({
  name: "vault-info: re-sending the vault's stored legacy params is allowed",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "legacy-params-vault",
      }, ADMIN_TOKEN);
      const vaultBody = await (await handleCreateVault(db, createVaultReq, ADMIN_TOKEN)).json() as {
        vault_id: string;
        salt: string;
      };
      const vaultId = vaultBody.vault_id;
      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-A",
      }, ADMIN_TOKEN);
      const devBody = await (await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN))
        .json() as { token: string };
      db.run(
        "UPDATE vaults SET argon2_ops = ?, argon2_mem = ? WHERE id = ?",
        LEGACY_OPS,
        LEGACY_MEM,
        vaultId,
      );

      const keysA = await deriveKeys(PASSPHRASE, b64decode(vaultBody.salt), {
        opsLimit: LEGACY_OPS,
        memLimit: LEGACY_MEM,
      });
      const verifierA = b64encode(await makeVerifier(keysA));
      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA, argon2_ops: LEGACY_OPS, argon2_mem: LEGACY_MEM },
        devBody.token,
        ADMIN_TOKEN,
      );
      assertEquals((await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN)).status, 200);

      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoBody = await (await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN))
        .json() as {
          argon2_ops: number | null;
          argon2_mem: number | null;
        };
      assertEquals(infoBody.argon2_ops, LEGACY_OPS);
      assertEquals(infoBody.argon2_mem, LEGACY_MEM);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: PUT different argon2 params on set params → 409 and unchanged",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "params-overwrite-vault",
      }, ADMIN_TOKEN);
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const keysA = await deriveKeys(PASSPHRASE, b64decode(vaultBody.salt), {
        opsLimit: 1,
        memLimit: 8192,
      });
      const verifierA = b64encode(await makeVerifier(keysA));

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA, argon2_ops: 3, argon2_mem: 67108864 },
        tokenA,
        ADMIN_TOKEN,
      );
      assertEquals((await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN)).status, 200);

      // Attempt to change params → 409.
      const overwriteReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierA, argon2_ops: 5, argon2_mem: 1 },
        tokenA,
        ADMIN_TOKEN,
      );
      const overwriteRes = await handlePutVerifier(db, vaultId, overwriteReq, ADMIN_TOKEN);
      assertEquals(overwriteRes.status, 409);

      const infoReq = makeReq(
        `http://localhost/vaults/${vaultId}/info`,
        "GET",
        undefined,
        ADMIN_TOKEN,
      );
      const infoBody = await (await handleGetVaultInfo(db, vaultId, infoReq, ADMIN_TOKEN))
        .json() as { argon2_ops: number | null; argon2_mem: number | null };
      assertEquals(infoBody.argon2_ops, 3, "stored ops must be unchanged");
      assertEquals(infoBody.argon2_mem, 67108864, "stored mem must be unchanged");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "createDevice: response includes argon2 ops/mem from vault",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      // Create vault, set verifier with params
      const createVaultReq = makeReq("http://localhost/vaults", "POST", {
        name: "device-params-vault",
      }, ADMIN_TOKEN);
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      assertEquals(createVaultRes.status, 201);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      // Set verifier with params
      const { token: tokenA } = await (async () => {
        const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
          device_name: "device-A",
        }, ADMIN_TOKEN);
        const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
        assertEquals(createDevRes.status, 201);
        const devBody = await createDevRes.json() as { token: string };
        return { token: devBody.token };
      })();

      const saltBytes = b64decode(vaultBody.salt);
      const keysA = await deriveKeys(PASSPHRASE, saltBytes, { opsLimit: 1, memLimit: 8192 });
      const verifier = await makeVerifier(keysA);
      const verifierB64 = b64encode(verifier);

      const putReq = makeReq(
        `http://localhost/vaults/${vaultId}/verifier`,
        "PUT",
        { verifier: verifierB64, argon2_ops: 3, argon2_mem: 67108864 },
        tokenA,
        ADMIN_TOKEN,
      );
      await handlePutVerifier(db, vaultId, putReq, ADMIN_TOKEN);

      // Create device B: response should include vault's params
      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-B",
      }, ADMIN_TOKEN);
      const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
      assertEquals(createDevRes.status, 201);
      const devBody = await createDevRes.json() as {
        argon2_ops: number | null;
        argon2_mem: number | null;
      };
      assertEquals(devBody.argon2_ops, 3);
      assertEquals(devBody.argon2_mem, 67108864);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: #560 device token of the vault is accepted; foreign device token is not",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultReq = makeReq(
        "http://localhost/vaults",
        "POST",
        { name: "info-vault" },
        ADMIN_TOKEN,
      );
      const createVaultRes = await handleCreateVault(db, createVaultReq, ADMIN_TOKEN);
      const vaultBody = await createVaultRes.json() as { vault_id: string; salt: string };
      const vaultId = vaultBody.vault_id;

      const createDevReq = makeReq(`http://localhost/vaults/${vaultId}/devices`, "POST", {
        device_name: "device-A",
      }, ADMIN_TOKEN);
      const createDevRes = await handleCreateDevice(db, vaultId, createDevReq, ADMIN_TOKEN);
      const devBody = await createDevRes.json() as { token: string };
      const tokenA = devBody.token;

      // A second vault with its own device, for the foreign-token case.
      const otherRes = await handleCreateVault(
        db,
        makeReq("http://localhost/vaults", "POST", { name: "other" }, ADMIN_TOKEN),
        ADMIN_TOKEN,
      );
      const otherBody = await otherRes.json() as { vault_id: string };
      const otherDevRes = await handleCreateDevice(
        db,
        otherBody.vault_id,
        makeReq(`http://localhost/vaults/${otherBody.vault_id}/devices`, "POST", {
          device_name: "device-X",
        }, ADMIN_TOKEN),
        ADMIN_TOKEN,
      );
      const otherDevBody = await otherDevRes.json() as { token: string };

      // Device token of THIS vault → 200 with salt/verifier/params.
      const own = await handleGetVaultInfo(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/info`, "GET", undefined, tokenA),
        ADMIN_TOKEN,
      );
      assertEquals(own.status, 200);
      const ownBody = await own.json() as { salt: string; verifier: string | null };
      assertEquals(ownBody.salt, vaultBody.salt);

      // Device token of ANOTHER vault → 403.
      const foreign = await handleGetVaultInfo(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/info`, "GET", undefined, otherDevBody.token),
        ADMIN_TOKEN,
      );
      assertEquals(foreign.status, 403);

      // No token → 401.
      const none = await handleGetVaultInfo(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/info`, "GET"),
        ADMIN_TOKEN,
      );
      assertEquals(none.status, 401);

      // Admin token still works.
      const admin = await handleGetVaultInfo(
        db,
        vaultId,
        makeReq(`http://localhost/vaults/${vaultId}/info`, "GET", undefined, ADMIN_TOKEN),
        ADMIN_TOKEN,
      );
      assertEquals(admin.status, 200);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-info: a token that is neither admin nor device records an admin failure",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);

      const createVaultRes = await handleCreateVault(
        db,
        makeReq("http://localhost/vaults", "POST", { name: "rate-vault" }, ADMIN_TOKEN),
        ADMIN_TOKEN,
      );
      const vaultBody = await createVaultRes.json() as { vault_id: string };
      const vaultId = vaultBody.vault_id;

      const badTokenReq = () => {
        const req = makeReq(
          `http://localhost/vaults/${vaultId}/info`,
          "GET",
          undefined,
          "not-a-real-token",
        );
        attachRemoteAddr(
          req,
          { transport: "tcp", hostname: "203.0.113.7", port: 1234 } as Deno.Addr,
        );
        return req;
      };

      try {
        // Five failures from the same IP, then the per-IP admin rate limit trips.
        for (let i = 1; i <= 5; i++) {
          const res = await handleGetVaultInfo(db, vaultId, badTokenReq(), ADMIN_TOKEN);
          assertEquals(res.status, 401, `failure ${i} is a 401`);
        }
        const limited = await handleGetVaultInfo(db, vaultId, badTokenReq(), ADMIN_TOKEN);
        assertEquals(
          limited.status,
          429,
          "hammering /info with bad tokens must trip the admin rate limit",
        );
      } finally {
        resetRateLimits();
      }
    } finally {
      removeTempDir(dataDir);
    }
  },
});
