// #701: the rebuild choreography "Resync from scratch" and a rejoin share: dispose the
// runtime, rebuild from the persisted rows, restart the session.

import { MASS_DELETE_NEEDS_RESUME } from "./mass-delete-hold.ts";
import { Transport } from "./transport.ts";
import { log } from "../plumbing/log.ts";
import { isSyncable, type PluginSettings } from "../plumbing/settings-types.ts";
import type { StateDB } from "../plumbing/state.ts";
import { openSessionState, reconnectAndWaitLive } from "../session.ts";
import { disposeRuntime, type VaultLockHost } from "../plumbing/vault-lock.ts";
import { rebuildFromScratch, type RecoveryStats, type ResyncDeps } from "./recovery.ts";

type RebuildHost = VaultLockHost & {
  app: { vault: { configDir: string } };
};

/** #701: what a session start (or Resume, or Resync) must do while a rejoin did not
 * finish: finish the rejoin, never replay the rows it left armed. */
export function rejoinAction(
  settings: Pick<PluginSettings, "rejoinIncomplete">,
): "rejoin" | "normal" {
  return settings.rejoinIncomplete ? "rejoin" : "normal";
}

/** #701: one transport for a rebuild that has no session to borrow one from: a rejoin
 * runs before the new device's session exists. The caller stops it. */
export function startRebuildTransport(
  host: { pluginSettings: PluginSettings; manifest: { version: string } },
): Transport {
  const transport = new Transport();
  transport.start(
    host.pluginSettings.serverUrl,
    host.pluginSettings.vaultId,
    host.pluginSettings.deviceId,
    host.pluginSettings.deviceToken,
    0,
    host.manifest.version,
  );
  return transport;
}

/** The rebuild both entry points run, on the persisted rows: the only witness of what
 * this device last agreed on. */
export async function rebuildVault(
  host: RebuildHost,
  transport: Transport,
  rejoin = false,
): Promise<RecoveryStats> {
  if (!host.keys) throw new Error("vault must be unlocked before resync");
  // #601: the hold stays in force until the rebuild has RETURNED: a rebuild that dies
  // half-way leaves rows open, and releasing the hold here would let the next start sync
  // the rest as deletes. A rejoin is already the restore-everything decision, and it runs
  // over its own transport rather than the held session's.
  const held = host.pluginSettings.massDeleteHold !== null;
  if (held && !rejoin) {
    if (host.pluginSettings.pauseAt > 0) throw new Error(MASS_DELETE_NEEDS_RESUME);
    await reconnectAndWaitLive(host);
  }
  let freshState: StateDB | null = null;
  try {
    // #701 review: dispose first: the old instance's close() flushes its rows as a
    // fire-and-forget write, and a stale flush landing after the rebuild would restore
    // them. Both are inside the try so a failure here stops sync too.
    disposeRuntime(host, { clearKeys: false, updateStatus: true });
    freshState = await openSessionState(host);
    const result = await rebuildFromScratch({
      vault: host.app.vault as unknown as ResyncDeps["vault"],
      transport,
      state: freshState,
      keys: host.keys,
      vaultId: host.pluginSettings.vaultId,
      isSyncable: (filePath) => isSyncable(filePath, host.app.vault.configDir, host.pluginSettings),
      parkedMoves: () => host.pluginSettings.pendingMoveOuts,
      rejoin,
    });
    log.info("rebuild done", {
      rejoin,
      appliedFiles: result.appliedFiles,
      deletedFiles: result.deletedFiles,
      latestSeq: result.latestSeq,
      backedUp: result.backup?.count ?? 0,
    });
    if (held) {
      host.pluginSettings.massDeleteHold = null;
      host.statusBar?.setMassDeleteHold(null);
      await host.saveSettings();
    }
    if (rejoin) {
      // #701: clear the marker that would send the next session back here, and lift the
      // pause only when this rejoin set it: a pause the user chose survives.
      if (host.pluginSettings.rejoinIncomplete) host.pluginSettings.pauseAt = 0;
      host.pluginSettings.rejoinIncomplete = false;
      await host.saveSettings();
    }
    await host.restartUnlockedSession(freshState);
    return result;
  } catch (error) {
    freshState?.close();
    // #701: a rejoin that dies part way must not leave the old rows armed for the next
    // session: the settings already carry the new device, so a persisted pause (and the
    // marker that makes the next session finish the rejoin) is what stops the stale state
    // from being replayed over the server.
    if (rejoin) {
      host.pluginSettings.pauseAt = Date.now();
      host.pluginSettings.rejoinIncomplete = true;
      await host.saveSettings();
    }
    throw error;
  }
}
