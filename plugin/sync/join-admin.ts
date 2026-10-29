import type { VaultKeys } from "../../core/crypto.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";

export type AdminJoinClients = {
  getVaultInfo(serverUrl: string, adminToken: string, vaultId: string): Promise<{
    salt: string;
    verifier: string | null;
    argon2Ops: number | null;
    argon2Mem: number | null;
  }>;
  createDevice(
    serverUrl: string,
    adminToken: string,
    vaultId: string,
    deviceName: string,
  ): Promise<{
    deviceId: string;
    token: string;
  }>;
  putVerifier(
    serverUrl: string,
    vaultId: string,
    token: string,
    verifierB64: string,
    argon2Params?: { ops: number; mem: number },
    adminToken?: string,
  ): Promise<void>;
};

export type AdminJoinCrypto = {
  deriveKeys(
    passphrase: string,
    salt: Uint8Array,
    params: { opsLimit: number; memLimit: number },
  ): Promise<VaultKeys>;
  checkVerifier(keys: VaultKeys, verifier: Uint8Array): Promise<boolean>;
  makeVerifier(keys: VaultKeys): Promise<Uint8Array>;
};

export type AdminJoinResult = {
  deviceId: string;
  token: string;
  salt: string;
  verifierB64: string;
  keys: VaultKeys;
  /** The argon2 params the keys were derived with: the vault's stored params,
   * or the caller's fallback for a NULL-params vault (#482). */
  argon2Params: { ops: number; mem: number };
};

export async function orchestrateAdminJoin(
  clients: AdminJoinClients,
  crypto: AdminJoinCrypto,
  opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
    argon2Params: { ops: number; mem: number };
  },
): Promise<AdminJoinResult> {
  const { serverUrl, adminToken, vaultId, deviceName, passphrase, argon2Params } = opts;

  const { salt, verifier: existingVerifier, argon2Ops, argon2Mem } = await clients.getVaultInfo(
    serverUrl,
    adminToken,
    vaultId,
  );

  // Use the vault's stored params when available; fall back to the calling device's params.
  const derivedParams = argon2Ops !== null && argon2Mem !== null
    ? { opsLimit: argon2Ops, memLimit: argon2Mem }
    : { opsLimit: argon2Params.ops, memLimit: argon2Params.mem };

  const keys = await crypto.deriveKeys(passphrase, b64decode(salt), derivedParams);

  let verifierB64 = existingVerifier ?? "";

  if (existingVerifier) {
    const ok = await crypto.checkVerifier(keys, b64decode(existingVerifier));
    if (!ok) throw new Error("incorrect passphrase");
  } else {
    // No existing verifier: generate one.
    const newVerifier = await crypto.makeVerifier(keys);
    verifierB64 = b64encode(newVerifier);
  }

  // Create the device only after the passphrase verifies: else wrong-passphrase joins orphan devices (#298).
  const { deviceId, token } = await clients.createDevice(
    serverUrl,
    adminToken,
    vaultId,
    deviceName,
  );

  // Store the new verifier, or backfill the params that verified a NULL-params vault (#356).
  // #675: a first (NULL) verifier is admin-gated, so the join's admin token goes along; a
  // backfill on a set verifier ignores it server-side.
  if (!existingVerifier || (argon2Ops === null && argon2Mem === null)) {
    await clients.putVerifier(serverUrl, vaultId, token, verifierB64, argon2Params, adminToken);
  }

  return {
    deviceId,
    token,
    salt,
    verifierB64,
    keys,
    argon2Params: { ops: derivedParams.opsLimit, mem: derivedParams.memLimit },
  };
}
