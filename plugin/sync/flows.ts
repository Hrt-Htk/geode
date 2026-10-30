import { Notice } from "obsidian";
import { checkVerifier, deriveKeys, makeVerifier, VaultKeys } from "../../core/crypto.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";
import { normalizeServerInput } from "../plumbing/scheme.ts";
import {
  createDevice as _createDevice,
  createVault as _createVault,
  getVaultInfo as _getVaultInfo,
  putVerifier as _putVerifier,
} from "../plumbing/provisioning-client.ts";
import { orchestrateAdminJoin } from "./join-admin.ts";
import { registerAuthTofu } from "../plumbing/rekey-client.ts";
import {
  NEW_VAULT_ARGON2_PARAMS,
  type PluginSettings,
  withVaultIdentity,
} from "../plumbing/settings-types.ts";
import { rejoinFailedNotice, rejoinResultText } from "../ui/setup-wizard-logic.ts";
import type { RejoinBackup } from "./rejoin.ts";

type FlowHost = {
  pluginSettings: PluginSettings;
  keys: VaultKeys | null;
  isUnlocked: boolean;
  saveSettings(): Promise<void>;
  restartUnlockedSession(): Promise<void>;
  /** #701: does this join land on an old copy of the same vault? */
  detectRejoin(vaultId: string): Promise<boolean>;
  /** #701: the rejoin rebuild: the server wins, and the doubtful bytes are set aside. */
  beginRejoinRebuild(): Promise<RejoinBackup | null>;
};

export async function createVaultFlow(
  host: FlowHost,
  opts: {
    serverUrl: string;
    adminToken: string;
    vaultName: string;
    deviceName: string;
    passphrase: string;
    argon2Params?: { ops: number; mem: number };
  },
): Promise<void> {
  const { serverUrl, adminToken, vaultName, deviceName, passphrase } = opts;
  const normalized = normalizeServerInput(serverUrl);
  const { vaultId, salt } = await _createVault(normalized, adminToken, vaultName);
  const { deviceId, token } = await _createDevice(normalized, adminToken, vaultId, deviceName);
  // The wizard passes the vault's chosen encryption strength (#459); anything
  // else derives at the Standard level (NEW_VAULT_ARGON2_PARAMS, #457).
  const argon2Params = opts.argon2Params
    ? { ...opts.argon2Params }
    : { ...NEW_VAULT_ARGON2_PARAMS };
  const keys = await deriveKeys(passphrase, b64decode(salt), {
    opsLimit: argon2Params.ops,
    memLimit: argon2Params.mem,
  });
  const verifierBytes = await makeVerifier(keys);
  const verifierB64 = b64encode(verifierBytes);
  // #675: the first (NULL) verifier write is admin-gated, so the wizard's admin
  // token goes along with the new device token.
  await _putVerifier(normalized, vaultId, token, verifierB64, argon2Params, adminToken);
  host.pluginSettings = withVaultIdentity(host.pluginSettings, {
    argon2Params,
    serverUrl: normalized,
    vaultId,
    deviceId,
    deviceName,
    deviceToken: token,
    salt,
    verifier: verifierB64,
  });
  await host.saveSettings();
  host.keys = keys;
  host.isUnlocked = true;
  // #675: a vault's first auth_hash registration needs the admin token, which
  // this flow holds.
  registerAuthTofu(host.pluginSettings, keys, adminToken);
  await host.restartUnlockedSession();
  new Notice("Geode: vault created");
}

export async function joinWithAdminFlow(
  host: FlowHost,
  opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  },
  keepWizardOpen = false,
): Promise<{ rejoin: RejoinBackup | null }> {
  const { serverUrl, adminToken, vaultId, deviceName, passphrase } = opts;
  const normalized = normalizeServerInput(serverUrl);
  // Before the settings lose the old vault id: is the folder this join lands on an old
  // copy of this vault (#701)?
  const rejoin = await host.detectRejoin(vaultId);

  let result;
  try {
    result = await orchestrateAdminJoin(
      { getVaultInfo: _getVaultInfo, createDevice: _createDevice, putVerifier: _putVerifier },
      { deriveKeys, checkVerifier, makeVerifier },
      {
        serverUrl: normalized,
        adminToken,
        vaultId,
        deviceName,
        passphrase,
        argon2Params: host.pluginSettings.argon2Params,
      },
    );
  } catch (e) {
    if (e instanceof Error && e.message === "incorrect passphrase") {
      // The wizard shows the inline error (mapJoinError); don't double-notify.
      if (!keepWizardOpen) new Notice("Incorrect passphrase. Try again.");
    }
    throw e;
  }

  host.pluginSettings = withVaultIdentity(host.pluginSettings, {
    serverUrl: normalized,
    vaultId,
    deviceId: result.deviceId,
    deviceName,
    deviceToken: result.token,
    salt: result.salt,
    verifier: result.verifierB64,
    argon2Params: result.argon2Params,
  });
  await host.saveSettings();
  host.keys = result.keys;
  host.isUnlocked = true;
  // #675: same admin-token requirement as create: a join may be the first
  // registration of the vault's auth_hash.
  registerAuthTofu(host.pluginSettings, result.keys, adminToken);
  // #701: a rejoin rebuilds before this session syncs anything: the old rows and cursor
  // would read the stale folder as local edits and upload it back over the server's
  // deletes. Anything else starts the session as before.
  let backup: RejoinBackup | null = null;
  if (rejoin) {
    try {
      backup = await host.beginRejoinRebuild();
    } catch (error) {
      // The rebuild paused sync before rethrowing: the old rows must never be replayed.
      new Notice(rejoinFailedNotice(), 15000);
      throw error;
    }
  } else {
    await host.restartUnlockedSession();
  }
  new Notice("Geode: joined vault");
  if (backup && !keepWizardOpen) new Notice(rejoinResultText(backup.count, backup.folder));
  return { rejoin: backup };
}
