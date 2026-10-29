// #560: unlock after the passphrase changed on another device: fetch the
// vault's current salt/verifier/params, derive with the vault's NEW params
// (Rule 7), verify, and rebuild the local path hashes. Paths are local, so
// only the keyed path_hash changes: versions, seq, plaintext hashes, chunk
// hashes and the sync cursor all survive the re-key. No full re-download.
import { checkVerifier, deriveKeys, type VaultKeys } from "../../core/crypto.ts";
import { hashPathHex } from "../../core/hash.ts";
import { b64decode } from "../../core/protocol.ts";
import { getVaultInfo } from "../plumbing/provisioning-client.ts";
import type { LocalFileRow, StateDB } from "../plumbing/state.ts";

export function rebuildLocalFileRows(
  rows: Iterable<LocalFileRow>,
  keys: VaultKeys,
): LocalFileRow[] {
  return [...rows].map((row) => ({ ...row, path_hash: hashPathHex(keys.mac_key, row.path) }));
}

export interface RemoteRekeyUnlock {
  keys: VaultKeys;
  verifierB64: string;
  argon2Params: { ops: number; mem: number };
}

export async function unlockAfterRemoteRekey(opts: {
  serverUrl: string;
  vaultId: string;
  deviceToken: string;
  passphrase: string;
  state: StateDB;
}): Promise<RemoteRekeyUnlock> {
  const info = await getVaultInfo(opts.serverUrl, opts.deviceToken, opts.vaultId);
  if (!info.verifier || info.argon2Ops === null || info.argon2Mem === null) {
    throw new Error("vault has no verifier");
  }
  const keys = await deriveKeys(opts.passphrase, b64decode(info.salt), {
    opsLimit: info.argon2Ops,
    memLimit: info.argon2Mem,
  });
  if (!(await checkVerifier(keys, b64decode(info.verifier)))) {
    throw new Error("incorrect passphrase");
  }
  for (const row of rebuildLocalFileRows(opts.state.getAllLocalFiles().values(), keys)) {
    opts.state.upsertLocalFile(row);
  }
  return {
    keys,
    verifierB64: info.verifier,
    argon2Params: { ops: info.argon2Ops, mem: info.argon2Mem },
  };
}
