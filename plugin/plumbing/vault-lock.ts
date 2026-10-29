// Vault lock lifecycle: passphrase unlock, lock, leave (revoke + wipe),
// key-cache save/restore, and runtime teardown. main.ts keeps thin delegations.

import { checkVerifier, deriveKeys, type VaultKeys } from "../../core/crypto.ts";
import { b64decode } from "../../core/protocol.ts";
import { formatError, log } from "./log.ts";
import {
  clearKeyCache,
  isCacheValid,
  loadKeyCache,
  resolveCachedKeys,
  saveKeyCache,
} from "./key-cache.ts";
import { clearedVaultSettings } from "./settings-types.ts";
import { revokeDeviceSelf } from "./provisioning-client.ts";
import { registerAuthTofu } from "./rekey-client.ts";
import {
  awaitStateWrites,
  disposeSession,
  openSessionState,
  startUnlockedSession,
  type SyncSessionHost,
} from "../session.ts";
import { unlockAfterRemoteRekey } from "../sync/rekey-recover.ts";
import type { RekeyCursor } from "../sync/rekey-run.ts";
import type { StateDB } from "./state.ts";
import type { VersionStatus } from "../sync/version-state.ts";

// #534: per-device, vault-scoped key cache (app.saveLocalStorage); never in the vault folder.
const KEY_CACHE_STORAGE_KEY = "key-cache";

export type VaultLockHost = SyncSessionHost & {
  // Structural (not obsidian's App) so the lock code stays obsidian-free and
  // testable; the real plugin's App satisfies it.
  app: {
    vault: { adapter: { remove(path: string): Promise<void> } };
    saveLocalStorage(key: string, value: unknown): void;
    loadLocalStorage(key: string): string | null;
  };
  isUnlocked: boolean;
  lastBackupAt: number;
  blockedNoticeShown: boolean;
  /** #559: the open re-key cursor, cleared when leaving the vault. */
  rekeyCursor: RekeyCursor | null;
  /** #560: the vault's passphrase changed on another device: locked until re-unlocked. */
  rekeyElsewhere: boolean;
  settingTab: { applyLockState(): void; display(): void } | null;
  statusBar:
    | (SyncSessionHost["statusBar"] & { setVersionStatus(status: VersionStatus): void })
    | null;
  restartUnlockedSession(existingState?: StateDB): Promise<void>;
  /** #464: the in-memory keys changed (locked, left, re-keyed): close surfaces
   * that decrypt, so none of them runs on stale keys. */
  onKeysChanged?: () => void;
};

export async function unlockVault(host: VaultLockHost, passphrase: string): Promise<void> {
  if (!host.settings.salt) {
    log.error("no salt configured");
    return;
  }
  const saltBytes = b64decode(host.settings.salt);
  const keys = await deriveKeys(passphrase, saltBytes, {
    opsLimit: host.settings.argon2Params.ops,
    memLimit: host.settings.argon2Params.mem,
  });
  if (host.settings.verifier) {
    const ok = await checkVerifier(keys, b64decode(host.settings.verifier));
    if (!ok) {
      // #560: the local verifier may be stale: the passphrase changed on
      // another device and the in-memory rekeyElsewhere flag is gone (restart).
      // Before rejecting, verify against the server's current verifier.
      try {
        await unlockAfterRemoteRekeyFlow(host, passphrase);
        return;
      } catch {
        host.keys = null;
        host.isUnlocked = false;
        throw new Error("incorrect passphrase");
      }
    }
  }
  host.keys = keys;
  host.isUnlocked = true;
  saveKeyCache((json) => host.app.saveLocalStorage(KEY_CACHE_STORAGE_KEY, json), keys);
  registerAuthTofu(host.settings, keys);
  await host.restartUnlockedSession();
  host.settingTab?.applyLockState();
}

// #560: hello_ack reported a verifier the device does not have: lock with the
// "passphrase changed elsewhere" state.
export function enterRekeyLockedState(host: VaultLockHost): void {
  host.rekeyElsewhere = true;
  lockVault(host);
}

// #560: unlock after a remote re-key: fetch the vault's current salt/
// verifier/params, derive with the vault's NEW params (Rule 7), verify, rebuild
// the local path hashes, then save the new cache + settings and resume.
export async function unlockAfterRemoteRekeyFlow(
  host: VaultLockHost,
  passphrase: string,
): Promise<void> {
  // The lock path disposed the runtime (host.state is null): rebuild the rows
  // from the persisted state files; the restart below re-wires the
  // device-gated persistence for them.
  const state = host.state ?? await openSessionState(host);
  const result = await unlockAfterRemoteRekey({
    serverUrl: host.settings.serverUrl,
    vaultId: host.settings.vaultId,
    deviceToken: host.settings.deviceToken,
    passphrase,
    state,
  });
  host.keys = result.keys;
  host.isUnlocked = true;
  host.rekeyElsewhere = false;
  saveKeyCache((json) => host.app.saveLocalStorage(KEY_CACHE_STORAGE_KEY, json), result.keys);
  host.settings = {
    ...host.settings,
    verifier: result.verifierB64,
    argon2Params: result.argon2Params,
  };
  await host.saveSettings();
  registerAuthTofu(host.settings, result.keys);
  await host.restartUnlockedSession(state);
  host.settingTab?.applyLockState();
}

export function lockVault(host: VaultLockHost): void {
  host.isUnlocked = false;
  clearKeyCache(() => clearKeyStore(host));
  disposeRuntime(host, { clearKeys: true, updateStatus: true });
  host.settingTab?.applyLockState();
}

export async function leaveVault(host: VaultLockHost): Promise<void> {
  // Capture before clearing: needed for server revoke
  const { serverUrl, vaultId, deviceToken, deviceId } = host.settings;

  host.isUnlocked = false;
  clearKeyCache(() => clearKeyStore(host));
  disposeRuntime(host, { clearKeys: true, updateStatus: true });
  // #744: the teardown above starts the final state writes; let them land, or
  // their rename recreates the files the delete below removes.
  await awaitStateWrites();

  // Best-effort server revoke: leave must succeed even if server is unreachable
  try {
    await revokeDeviceSelf(serverUrl, vaultId, deviceToken, deviceId);
  } catch {
    log.warn("server revoke failed during leave vault, continuing locally", { serverUrl, vaultId });
  }

  for (
    const name of ["local-files.json", "sync-cursor.json", "activity-log.json", "rekey-cursor.json"]
  ) {
    try {
      await host.app.vault.adapter.remove(host.pluginDataPath(name));
    } catch { /* may not exist */ }
  }
  host.rekeyCursor = null;
  host.rekeyElsewhere = false;
  host.activity?.clear();
  host.settings = clearedVaultSettings(host.settings);
  await host.saveSettings();
  host.lastBackupAt = 0;
  host.settingTab?.display();
}

function clearKeyStore(host: VaultLockHost): void {
  host.app.saveLocalStorage(KEY_CACHE_STORAGE_KEY, null);
}

export async function restartUnlockedSession(
  host: VaultLockHost,
  existingState?: StateDB,
): Promise<void> {
  await startUnlockedSession(host, existingState);
}

export async function tryCachedKeys(host: VaultLockHost): Promise<boolean> {
  const cached = loadKeyCache(() => host.app.loadLocalStorage(KEY_CACHE_STORAGE_KEY));
  if (!isCacheValid(cached, host.settings.unlockTimeoutHours)) {
    if (cached) {
      clearKeyCache(() => clearKeyStore(host));
    }
    return false;
  }
  const keys = resolveCachedKeys(cached);
  if (!keys) {
    clearKeyCache(() => clearKeyStore(host));
    return false;
  }
  if (host.settings.verifier) {
    const ok = await checkVerifier(keys, b64decode(host.settings.verifier));
    if (!ok) {
      clearKeyCache(() => clearKeyStore(host));
      return false;
    }
  }
  host.keys = keys;
  host.isUnlocked = true;
  await host.restartUnlockedSession();
  return true;
}

// #557: post-switch hook for the re-key modal (#559): swap the cached keys,
// store the new verifier + params, and restart the unlocked session.
export async function finishRekey(
  host: VaultLockHost,
  newKeys: VaultKeys,
  params: { ops: number; mem: number },
  verifierB64: string,
): Promise<void> {
  host.keys = newKeys;
  host.isUnlocked = true;
  // The history modal decrypted under the old keys: close it before the restart.
  notifyKeysChanged(host);
  saveKeyCache((json) => host.app.saveLocalStorage(KEY_CACHE_STORAGE_KEY, json), newKeys);
  host.settings = { ...host.settings, verifier: verifierB64, argon2Params: params };
  await host.saveSettings();
  await host.restartUnlockedSession();
  host.settingTab?.applyLockState();
}

function notifyKeysChanged(host: VaultLockHost): void {
  try {
    host.onKeysChanged?.();
  } catch (error) {
    log.warn("keys-changed hook failed", { error: formatError(error) });
  }
}

export function disposeRuntime(
  host: VaultLockHost,
  opts: { clearKeys: boolean; updateStatus: boolean },
): void {
  disposeSession(host);
  host.blockedNoticeShown = false;
  if (opts.clearKeys) {
    host.keys = null;
    notifyKeysChanged(host);
  }
  if (opts.updateStatus) {
    host.statusBar?.updateState("disconnected");
    host.statusBar?.updatePending(0);
    host.statusBar?.updateDirty(0);
    host.statusBar?.setVersionStatus({ kind: "ok" });
  }
}
