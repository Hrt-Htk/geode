import { Notice } from "obsidian";
import { resyncDoneNotice, resyncNoticeText, type ResyncState } from "./resync-status.ts";

/** #54: one notice that updates in place while a rebuild runs, mirrored onto the status
 * bar (so the settings row shows the same thing). */
export class ResyncProgress {
  private notice: Notice | null = null;

  constructor(private setStatus: (state: ResyncState | null) => void) {}

  start(): void {
    this.show({ phase: "running", current: 0, total: 0 });
  }

  update(current: number, total: number): void {
    this.show({ phase: "running", current, total });
  }

  /** The progress notice is replaced by a normal one that fades, and the row goes back to
   * the live sync status. */
  done(updated: number): void {
    this.stop();
    new Notice(resyncDoneNotice(updated));
  }

  /** Hand the status bar back without a notice of our own: a rejoin reports its backup,
   * and a failed rejoin reports the pause it made. */
  stop(): void {
    this.notice?.hide();
    this.notice = null;
    this.setStatus(null);
  }

  failed(reason: string): void {
    this.stop();
    this.setStatus({ phase: "failed", reason });
    new Notice(resyncNoticeText({ phase: "failed", reason }));
  }

  private show(state: ResyncState): void {
    this.setStatus(state);
    const text = resyncNoticeText(state);
    if (this.notice) this.notice.setMessage(text);
    else this.notice = new Notice(text, 0);
  }
}
