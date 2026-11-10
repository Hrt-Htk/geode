import type { RejoinBackup } from "../sync/rejoin.ts";
import { rebuildVault, startRebuildTransport } from "../sync/rebuild-flow.ts";
import { ResyncProgress } from "./resync-progress.ts";
import { type ResyncState, resyncStopReason } from "./resync-status.ts";

/** #54: what the two rebuild entry points need from the plugin: the rebuild host, and the
 * bar they report through. */
export type ResyncRunHost =
  & Parameters<typeof rebuildVault>[0]
  & {
    statusBar: { setResync(state: ResyncState | null): void; setPausedAt(ts: number): void } | null;
  };

/** "Resync from scratch": the surfaces run with the rebuild, and a stop keeps its reason. */
export async function runResync(
  host: ResyncRunHost,
  transport: Parameters<typeof rebuildVault>[1],
): Promise<void> {
  const progress = new ResyncProgress((state) => host.statusBar?.setResync(state));
  progress.start();
  try {
    const result = await rebuildVault(host, transport, {
      onProgress: (p) => progress.update(p.current, p.total),
    });
    progress.done(result.appliedFiles);
  } catch (error) {
    progress.failed(resyncStopReason(error));
    throw error;
  }
}

/** #701: the join landed on an old copy of this vault: rebuild over a transport with the
 * device token the join just issued (the live session still holds the old one, a revoked
 * one), then report where the doubt was set aside. #54: the same running surfaces as the
 * command, but a failure keeps its own answer: the pause, and the join's notice. */
export async function runRejoinRebuild(host: ResyncRunHost): Promise<RejoinBackup | null> {
  const transport = startRebuildTransport(host);
  const progress = new ResyncProgress((state) => host.statusBar?.setResync(state));
  progress.start();
  try {
    const backup = (await rebuildVault(host, transport, {
      rejoin: true,
      onProgress: (p) => progress.update(p.current, p.total),
    })).backup;
    // Not an unconditional zero: a pause the user chose survives a rejoin.
    host.statusBar?.setPausedAt(host.pluginSettings.pauseAt);
    progress.stop();
    return backup;
  } catch (error) {
    // #701: show the stop at once: the bar would otherwise keep saying disconnected.
    progress.stop();
    host.statusBar?.setPausedAt(host.pluginSettings.pauseAt);
    throw error;
  } finally {
    transport.stop();
  }
}
