// #701: the rebuild choreography "Resync from scratch" and a rejoin share: dispose the
// runtime, rebuild from the persisted rows, restart the session.

import { MASS_DELETE_NEEDS_RESUME } from "./mass-delete-hold.ts";
import { Transport } from "./transport.ts";
import { formatError, log } from "../plumbing/log.ts";
import { isSyncable, type PluginSettings } from "../plumbing/settings-types.ts";
import type { StateDB } from "../plumbing/state.ts";
import { awaitStateWrites, openSessionState, reconnectAndWaitLive } from "../session.ts";
import { disposeRuntime, type VaultLockHost } from "../plumbing/vault-lock.ts";
import { rebuildFromScratch, type RecoveryStats, type ResyncDeps } from "./recovery.ts";
import { RESYNC_UNFINISHED } from "../ui/resync-status.ts";

export type RebuildHost = VaultLockHost & {
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

type RebuildOptions = {
  rejoin?: boolean;
  /** #54: once per head, so the caller can show how far the rebuild got. */
  onProgress?: (progress: { current: number; total: number }) => void;
  /** With no transport passed, the rebuild builds its own (default: a bare one carrying this
   * device's credentials). Injected so a test can watch when it starts. */
  createTransport?: (host: RebuildHost) => Transport;
};

/** The rebuild both entry points run, on the persisted rows: the only witness of what
 * this device last agreed on. */
export async function rebuildVault(
  host: RebuildHost,
  transport: Transport | null,
  opts: RebuildOptions = {},
): Promise<RecoveryStats> {
  const rejoin = opts.rejoin === true;
  const onProgress = opts.onProgress;
  const createTransport = opts.createTransport ?? startRebuildTransport;
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
  /** The rebuild's own transport, when the caller has none: it is started only after a held
   * delete's reconnect, so two live transports from one device never meet (the server evicts
   * the second as a duplicate). */
  let ownTransport: Transport | null = null;
  try {
    // #701 review: dispose first: the old instance's close() flushes its rows as a
    // fire-and-forget write, and a stale flush landing after the rebuild would restore
    // them. Both are inside the try so a failure here stops sync too.
    disposeRuntime(host, { clearKeys: false, updateStatus: true, keepEpoch: true });
    freshState = await openSessionState(host);
    // With no transport passed, the session's is stopped by now: the rebuild's own is the
    // only handshake. A caller's transport (a rejoin's, on another device token) is its own.
    if (!transport) {
      ownTransport = createTransport(host);
      transport = ownTransport;
    }
    const result = await rebuildFromScratch({
      vault: host.app.vault as unknown as ResyncDeps["vault"],
      transport,
      state: freshState,
      keys: host.keys,
      vaultId: host.pluginSettings.vaultId,
      isSyncable: (filePath) => isSyncable(filePath, host.app.vault.configDir, host.pluginSettings),
      deviceName: host.pluginSettings.deviceName,
      parkedMoves: () => host.pluginSettings.pendingMoveOuts,
      rejoin,
      onProgress,
      onRowsMayChange: async () => {
        // #54 (crash): persist before the first row can change. A force quit or an OOM mid
        // rebuild then leaves the marker, so the next start does not replay half-restored
        // rows as deletes. The reason is replaced if the rebuild fails.
        await setResyncMarker(host, RESYNC_UNFINISHED);
      },
    });
    log.info("rebuild done", {
      rejoin,
      appliedFiles: result.appliedFiles,
      deletedFiles: result.deletedFiles,
      latestSeq: result.latestSeq,
      backedUp: result.backup?.count ?? 0,
    });
    await finishRebuild(host, freshState, { held, rejoin });
    return result;
  } catch (error) {
    // One handshake at a time: nothing below may reach the network while this transport is
    // still connecting (the server would evict one as a duplicate device).
    ownTransport?.stop();
    ownTransport = null;
    if (rejoin) await pauseForIncompleteRejoin(host, freshState);
    // A failure past the head list keeps the stop: the rows may be half restored. One
    // before it never changed a row, so the session restarts on the persisted rows.
    else if (host.pluginSettings.resyncStop !== "") {
      await setResyncMarker(host, formatError(error));
    } else await restartAfterFailedRebuild(host, freshState);
    throw error;
  } finally {
    ownTransport?.stop();
  }
}

/** The success path after the head loop: release the held delete, finish a rejoin, make the
 * rebuilt rows durable, clear the stop and restart the session on them. */
async function finishRebuild(
  host: RebuildHost,
  state: StateDB,
  opts: { held: boolean; rejoin: boolean },
): Promise<void> {
  if (opts.held) {
    host.pluginSettings.massDeleteHold = null;
    host.statusBar?.setMassDeleteHold(null);
    await host.saveSettings();
  }
  if (opts.rejoin) await finishRejoin(host);
  // #54: the rows are consistent again, and durable before the marker goes. The rows file is
  // on a trailing throttle and the rebuild has no host.state, so only closing the state
  // flushes it; startUnlockedSession re-wires a passed, closed state (#560).
  state.close();
  await awaitStateWrites();
  await setResyncMarker(host, null);
  await host.restartUnlockedSession(state, { keepEpoch: true });
}

/** #701: clear the marker that would send the next session back here, and lift the pause
 * only when this rejoin set it: a pause the user chose survives. */
async function finishRejoin(host: RebuildHost): Promise<void> {
  if (host.pluginSettings.rejoinIncomplete) host.pluginSettings.pauseAt = 0;
  host.pluginSettings.rejoinIncomplete = false;
  await host.saveSettings();
}

/** #54: the persisted stop, or its clearing (`null`). It is written before the rebuild can
 * change a row, so a crash mid rebuild still lands on the stopped state. */
async function setResyncMarker(host: RebuildHost, reason: string | null): Promise<void> {
  host.pluginSettings.resyncStop = reason ?? "";
  await host.saveSettings();
}

/** #701: a rejoin that dies part way must not leave the old rows armed for the next session:
 * the settings already carry the new device, so a persisted pause (and the marker that makes
 * the next session finish the rejoin) is what stops the stale state from being replayed over
 * the server. */
async function pauseForIncompleteRejoin(
  host: RebuildHost,
  state: StateDB | null,
): Promise<void> {
  state?.close();
  host.pluginSettings.pauseAt = Date.now();
  host.pluginSettings.rejoinIncomplete = true;
  await host.saveSettings();
}

/** #54: the dispose above took the live session with it, so a failure BEFORE the rebuild
 * touched anything must restart it, or sync is stranded in "disconnected" until a reload.
 * The persisted rows are the same rows a normal start would open. */
async function restartAfterFailedRebuild(
  host: RebuildHost,
  state: StateDB | null,
): Promise<void> {
  if (!state) return;
  try {
    await host.restartUnlockedSession(state, { keepEpoch: true });
  } catch (error) {
    log.error("rebuild restart failed", { error: formatError(error) });
    // #54 review: a restart can die after it created the transport. Leave the truth (nothing
    // is syncing), not a bar that describes a live session.
    disposeRuntime(host, { clearKeys: false, updateStatus: true, keepEpoch: true });
  }
}
