import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type AdminJoinClients,
  type AdminJoinCrypto,
  type AdminJoinResult,
  orchestrateAdminJoin,
} from "../../../plugin/sync/join-admin.ts";
import { checkVerifier, deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";

const ADMIN_TOKEN = "test-admin";
const VAULT_ID = "test-vault-id";
const DEVICE_NAME = "test-device";
const PASSPHRASE = "test";

const FAST_PARAMS = { ops: 1, mem: 8192 };

// Fixed 16-byte salt for deterministic test data.
const FIXED_SALT = new Uint8Array([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
]);

// Precompute the correct verifier for PASSPHRASE over FIXED_SALT.
let _correctVerifierB64: string | undefined;
async function getCorrectVerifierB64(): Promise<string> {
  if (_correctVerifierB64) return _correctVerifierB64;
  const keys = await deriveKeys(PASSPHRASE, FIXED_SALT, {
    opsLimit: FAST_PARAMS.ops,
    memLimit: FAST_PARAMS.mem,
  });
  const verifier = await makeVerifier(keys);
  _correctVerifierB64 = b64encode(verifier);
  return _correctVerifierB64;
}

// Build a fake client whose calls are recorded in order.
function makeFakeClients(
  vaultInfoOverride?: {
    verifier: string | null;
    argon2Ops: number | null;
    argon2Mem: number | null;
  },
  createDeviceReject?: Error,
): {
  clients: AdminJoinClients;
  calls: string[];
  putVerifierParams: { ops: number; mem: number } | undefined;
  putVerifierVerifier: string | undefined;
  putVerifierAdmin: string | undefined;
} {
  const calls: string[] = [];
  let putVerifierParams: { ops: number; mem: number } | undefined;
  let putVerifierVerifier: string | undefined;
  let putVerifierAdmin: string | undefined;
  return {
    clients: {
      getVaultInfo: async () => {
        calls.push("getVaultInfo");
        const verifier = vaultInfoOverride
          ? vaultInfoOverride.verifier
          : await getCorrectVerifierB64();
        return {
          salt: b64encode(FIXED_SALT),
          verifier,
          argon2Ops: vaultInfoOverride?.argon2Ops ?? null,
          argon2Mem: vaultInfoOverride?.argon2Mem ?? null,
        };
      },
      createDevice: () => {
        calls.push("createDevice");
        if (createDeviceReject) return Promise.reject(createDeviceReject);
        return Promise.resolve({ deviceId: "dev-1", token: "tok-1" });
      },
      putVerifier: (_serverUrl, _vaultId, _token, _verifier, params, adminToken) => {
        calls.push("putVerifier");
        putVerifierParams = params;
        putVerifierVerifier = _verifier;
        putVerifierAdmin = adminToken;
        return Promise.resolve();
      },
    },
    calls,
    get putVerifierParams() {
      return putVerifierParams;
    },
    get putVerifierVerifier() {
      return putVerifierVerifier;
    },
    get putVerifierAdmin() {
      return putVerifierAdmin;
    },
  };
}

const crypto: AdminJoinCrypto = {
  deriveKeys,
  checkVerifier,
  makeVerifier,
};

const baseOpts = {
  serverUrl: "http://localhost",
  adminToken: ADMIN_TOKEN,
  vaultId: VAULT_ID,
  deviceName: DEVICE_NAME,
  passphrase: PASSPHRASE,
  argon2Params: FAST_PARAMS,
};

// #675: the join writes the vault's first (NULL) verifier, which the server
// only accepts with the admin token.
Deno.test("orchestrateAdminJoin - forwards the admin token to a first verifier write", async () => {
  const fake = makeFakeClients({ verifier: null, argon2Ops: null, argon2Mem: null });
  await orchestrateAdminJoin(fake.clients, crypto, baseOpts);
  assertEquals(fake.calls.includes("putVerifier"), true);
  assertEquals(fake.putVerifierAdmin, ADMIN_TOKEN);
});

Deno.test({
  name: "orchestrateAdminJoin: wrong passphrase does NOT create device",
  async fn() {
    const { clients, calls } = makeFakeClients();

    await assertRejects(
      () =>
        orchestrateAdminJoin(clients, crypto, {
          ...baseOpts,
          passphrase: "wrong",
        }),
      Error,
      "incorrect passphrase",
    );

    // The critical invariant: createDevice must NOT have been called.
    assert(
      !calls.includes("createDevice"),
      `createDevice was called on wrong passphrase: calls: ${calls.join(", ")}`,
    );
    // But getVaultInfo and deriveKeys should have run.
    assertEquals(calls[0], "getVaultInfo");
    // checkVerifier runs internally (not in calls), but we know it threw.
  },
});

Deno.test({
  name: "orchestrateAdminJoin: correct passphrase: createDevice called once, after getVaultInfo",
  async fn() {
    const { clients, calls } = makeFakeClients();

    const result: AdminJoinResult = await orchestrateAdminJoin(
      clients,
      crypto,
      baseOpts,
    );

    assertEquals(result.deviceId, "dev-1");
    assertEquals(result.token, "tok-1");

    // Ordering invariant: getVaultInfo before createDevice.
    const giIdx = calls.indexOf("getVaultInfo");
    const cdIdx = calls.indexOf("createDevice");
    assert(giIdx < cdIdx, "getVaultInfo must precede createDevice");
    assertEquals(calls.filter((c) => c === "createDevice").length, 1);
  },
});

Deno.test({
  name: "orchestrateAdminJoin: no-verifier vault: createDevice then putVerifier",
  async fn() {
    const { clients, calls } = makeFakeClients({
      verifier: null,
      argon2Ops: null,
      argon2Mem: null,
    });

    const result: AdminJoinResult = await orchestrateAdminJoin(
      clients,
      crypto,
      baseOpts,
    );

    assertEquals(result.verifierB64.length > 0, true, "should have a new verifier");

    // Ordering: createDevice before putVerifier.
    const cdIdx = calls.indexOf("createDevice");
    const pvIdx = calls.indexOf("putVerifier");
    assert(cdIdx < pvIdx, "createDevice must precede putVerifier in no-verifier vault");
  },
});

// ── Argon2 params tests (issue #298) ──

Deno.test({
  name: "orchestrateAdminJoin: vault reports stored params, uses them instead of local default",
  async fn() {
    // Vault has stored params {ops:5,mem:99999} that differ from local default (FAST_PARAMS).
    const STORED_PARAMS = { ops: 5, mem: 99999 };

    // Derive verifier with the stored params.
    const storedKeys = await deriveKeys(PASSPHRASE, FIXED_SALT, {
      opsLimit: STORED_PARAMS.ops,
      memLimit: STORED_PARAMS.mem,
    });
    const verifier = await makeVerifier(storedKeys);
    const verifierB64 = b64encode(verifier);

    const { clients, calls } = makeFakeClients({
      verifier: verifierB64,
      argon2Ops: STORED_PARAMS.ops,
      argon2Mem: STORED_PARAMS.mem,
    });

    // Local default differs from vault params.
    const result: AdminJoinResult = await orchestrateAdminJoin(
      clients,
      crypto,
      { ...baseOpts, argon2Params: { ops: 7, mem: 77777 } },
    );

    assertEquals(result.deviceId, "dev-1");
    // Should have used the vault's stored params (storedKeys), not local default.
    assertEquals(result.keys.content_key, storedKeys.content_key);
    assertEquals(calls.filter((c) => c === "createDevice").length, 1);
  },
});

// ── Issue #482: the join result must carry the params used, so joinWithAdminFlow
// can store them in settings.argon2Params: else a joined device of a 3/256 MiB vault
// derives with its local default and the correct passphrase fails after lock.

Deno.test({
  name: "orchestrateAdminJoin: result carries the vault's stored params",
  async fn() {
    const STORED_PARAMS = { ops: 5, mem: 99999 };
    const storedKeys = await deriveKeys(PASSPHRASE, FIXED_SALT, {
      opsLimit: STORED_PARAMS.ops,
      memLimit: STORED_PARAMS.mem,
    });
    const verifier = await makeVerifier(storedKeys);
    const verifierB64 = b64encode(verifier);

    const { clients } = makeFakeClients({
      verifier: verifierB64,
      argon2Ops: STORED_PARAMS.ops,
      argon2Mem: STORED_PARAMS.mem,
    });

    const result: AdminJoinResult = await orchestrateAdminJoin(
      clients,
      crypto,
      { ...baseOpts, argon2Params: { ops: 7, mem: 77777 } },
    );

    assertEquals(
      result.argon2Params,
      STORED_PARAMS,
      "join must store the vault's params, not the caller's default",
    );
  },
});

Deno.test({
  name: "orchestrateAdminJoin: NULL-params vault: result carries the fallback params used",
  async fn() {
    const existingVerifier = await getCorrectVerifierB64();
    const fake = makeFakeClients({
      verifier: existingVerifier,
      argon2Ops: null,
      argon2Mem: null,
    });

    const result: AdminJoinResult = await orchestrateAdminJoin(
      fake.clients,
      crypto,
      baseOpts, // argon2Params = FAST_PARAMS, matching the verifier
    );

    assertEquals(
      result.argon2Params,
      FAST_PARAMS,
      "NULL-params vault must report the fallback params it backfilled",
    );
  },
});

Deno.test({
  name: "orchestrateAdminJoin: NULL-params vault matching current default backfills params",
  async fn() {
    // Vault has NULL params (pre-#298) but the verifier matches under the CURRENT default
    // params. The join succeeds via the primary path, and those params must be backfilled.
    const existingVerifier = await getCorrectVerifierB64();
    const fake = makeFakeClients({
      verifier: existingVerifier,
      argon2Ops: null,
      argon2Mem: null,
    });

    const result: AdminJoinResult = await orchestrateAdminJoin(
      fake.clients,
      crypto,
      baseOpts, // argon2Params = FAST_PARAMS, matching the verifier
    );

    assertEquals(result.deviceId, "dev-1");
    // Backfill: putVerifier MUST be called with the EXISTING verifier + current default params.
    assert(fake.calls.includes("putVerifier"), "NULL-params vault should backfill via putVerifier");
    assertEquals(
      fake.putVerifierVerifier,
      existingVerifier,
      "putVerifier must re-send the identical existing verifier",
    );
    assertEquals(fake.putVerifierParams?.ops, FAST_PARAMS.ops);
    assertEquals(fake.putVerifierParams?.mem, FAST_PARAMS.mem);
  },
});

Deno.test({
  name:
    "orchestrateAdminJoin: NULL-params vault whose verifier doesn't match the device params throws",
  async fn() {
    // Pre-#298 params: no longer retried (#421).
    const UNKNOWN_PARAMS = { ops: 2, mem: 65536 };

    const unknownKeys = await deriveKeys(PASSPHRASE, FIXED_SALT, {
      opsLimit: UNKNOWN_PARAMS.ops,
      memLimit: UNKNOWN_PARAMS.mem,
    });
    const verifier = await makeVerifier(unknownKeys);
    const verifierB64 = b64encode(verifier);

    const { clients, calls } = makeFakeClients({
      verifier: verifierB64,
      argon2Ops: null,
      argon2Mem: null,
    });

    await assertRejects(
      () =>
        orchestrateAdminJoin(clients, crypto, {
          ...baseOpts,
          argon2Params: { ops: 7, mem: 77777 },
        }),
      Error,
      "incorrect passphrase",
    );
    // No device created on failure.
    assert(!calls.includes("createDevice"));
  },
});
