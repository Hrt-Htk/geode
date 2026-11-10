import { Notice } from "obsidian";
import type { RejoinBackup } from "../sync/rejoin.ts";
import type { ProgressInfo } from "../sync/recovery.ts";
import { type RebuildHost, rebuildVault, startRebuildTransport } from "../sync/rebuild-flow.ts";
import {
  resyncCopy,
  resyncDoneNotice,
  resyncRenderDue,
  type ResyncState,
  resyncStopReason,
} from "./resync-status.ts";

/** #54: what the two rebuild entry points need from the plugin: the rebuild host, the bar
 * they report through, and the session epoch they belong to. */
export type ResyncRunHost = RebuildHost & {
  statusBar: { setResync(state: ResyncState | null): void; setPausedAt(ts: number): void } | null;
};

/** #54: one notice that updates in place while the run goes (about four renders a second),
 * mirrored onto the status bar so the settings row shows the same thing. */
class ResyncProgress {
  private notice: Notice | null = null;
  private lastRenderAt = 0;
  private renderedCount = 0;
  /** The session this run started in: any later boundary (lock, leave, unload, a new
   * session) ends it. */
  private readonly epoch: number;

  constructor(private host: ResyncRunHost) {
    this.epoch = host.syncEpoch;
  }

  update(progress: ProgressInfo): void {
    if (this.gone()) return;
    const now = Date.now();
    if (!resyncRenderDue(progress, this.lastRenderAt, now, this.renderedCount)) return;
    this.lastRenderAt = now;
    this.renderedCount = progress.current;
    const state: ResyncState = { phase: "running", progress };
    this.host.statusBar?.setResync(state);
    const { notice } = resyncCopy(state);
    if (this.notice) this.notice.setMessage(notice);
    else this.notice = new Notice(notice, 0);
  }

  /** The progress notice is replaced by a normal one that fades, and the row goes back to
   * the live sync status. */
  done(updated: number): void {
    const gone = this.gone();
    this.hide();
    if (gone) return;
    this.host.statusBar?.setResync(null);
    new Notice(resyncDoneNotice(updated));
  }

  /** Hand the status bar back without a notice of our own: a rejoin reports its backup. */
  stop(): void {
    const gone = this.gone();
    this.hide();
    if (!gone) this.host.statusBar?.setResync(null);
  }

  /** `syncStopped`: no session is left behind, so this state is the whole sync status. */
  failed(reason: string, syncStopped: boolean): void {
    const gone = this.gone();
    this.hide();
    if (gone) return;
    const state: ResyncState = { phase: "failed", reason, syncStopped };
    this.host.statusBar?.setResync(state);
    new Notice(resyncCopy(state).notice);
  }

  /** #54 review: a run belongs to the session it started in. Once that session is gone (a
   * lock, a leave, an unload, a new address or vault), progress and a stop would describe a
   * session that no longer exists. A done or a stop only clears the run's own state. */
  private gone(): boolean {
    return this.host.syncEpoch !== this.epoch;
  }

  private hide(): void {
    this.notice?.hide();
    this.notice = null;
  }
}

/** "Resync from scratch": the surfaces run with the rebuild, and a stop keeps its reason.
 * The rebuild builds and owns its transport (`null` here): it starts it only once the
 * session's is stopped, so a held delete's reconnect and the rebuild never hold two live
 * connections from one device at once. */
export async function runResync(host: ResyncRunHost): Promise<void> {
  const progress = new ResyncProgress(host);
  progress.update({ current: 0, total: 0 });
  try {
    const result = await rebuildVault(host, null, {
      onProgress: (p) => progress.update(p),
    });
    progress.done(result.appliedFiles);
  } catch (error) {
    // A restart leaves a transport behind; a rebuild that stopped for good leaves none, and
    // then the stopped state is the only thing telling sync's own story.
    progress.failed(resyncStopReason(error), host.transport === null);
    throw error;
  }
}

/** #701: the join landed on an old copy of this vault: rebuild over a transport with the
 * device token the join just issued (the live session still holds the old one, a revoked
 * one), then report where the doubt was set aside. #54: the same running surfaces as the
 * command, but a failure keeps its own answer: the pause, and the join's notice. */
export async function runRejoinRebuild(host: ResyncRunHost): Promise<RejoinBackup | null> {
  const transport = startRebuildTransport(host);
  const progress = new ResyncProgress(host);
  progress.update({ current: 0, total: 0 });
  try {
    return (await rebuildVault(host, transport, {
      rejoin: true,
      onProgress: (p) => progress.update(p),
    })).backup;
  } finally {
    transport.stop();
    progress.stop();
    // Not an unconditional zero: a pause the user chose survives a rejoin.
    host.statusBar?.setPausedAt(host.pluginSettings.pauseAt);
  }
}
