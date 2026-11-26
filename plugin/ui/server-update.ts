import { App, Notice } from "obsidian";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import {
  fetchServerVersion,
  fetchUpdateStatus,
  requestServerUpdate,
} from "../plumbing/update-client.ts";
import { isAdminAuthFailure } from "../plumbing/errors.ts";
import { formatError, log } from "../plumbing/log.ts";
import { windowGlobal } from "../plumbing/window.ts";
import { withAdminToken } from "./admin-token-modal.ts";
import { ServerUpdateModal } from "./server-update-modal.ts";
import {
  freshResult,
  INITIAL_FAILURE_STATE,
  noteJobStatus,
  noteUpdateFailure,
  noteUpdateSuccess,
  noticeDue,
  notRun,
  SERVER_UPDATE_COMMAND,
  type ServerUpdateInput,
  UPDATE_BUTTON,
  UPDATE_NO_JOB,
  UPDATE_NOTICE,
  UPDATE_TOKEN_MESSAGE,
  UPDATE_TOKEN_TITLE,
  updateExpired,
  type UpdateFailureState,
  type UpdateOutcome,
  updateOutcome,
} from "./server-update-logic.ts";

/** Two seconds: the job takes seconds to minutes and every poll is two tiny reads. */
const POLL_MS = 2_000;

export type ServerUpdateState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; outcome: UpdateOutcome };

/** Everything the run reads from the plugin; the dialog and the Status row render its state. */
export type ServerUpdateHost = {
  app: App;
  settings: () => Pick<PluginSettings, "serverUrl" | "deviceToken" | "updateNoticeVersion">;
  saveSettings: () => Promise<void>;
  ownVersion: () => string;
  adminToken: () => string | null;
  setAdminToken: (token: string | null) => void;
  /** The state changed: re-describe the Status row in place. */
  onChange: () => void;
  /** #51: the server finished updating; resume sync if it was blocked. */
  onUpdated: (word: string, version: string) => void;
};

/** #44/#51: runs one server update and reports it. Dialog-scoped state, plugin-scoped run:
 * closing the dialog hides it, the polling and the row keep going. */
export class ServerUpdate {
  state: ServerUpdateState = { kind: "idle" };
  /** A heartbeat younger than three minutes; null until the first read answers. */
  jobInstalled: boolean | null = null;
  private failure: UpdateFailureState = INITIAL_FAILURE_STATE;
  private modal: ServerUpdateModal | null = null;
  private timer: number | null = null;
  private requestEpoch = 0;
  private postedAt = 0;
  private lastResultAt = 0;

  constructor(private host: ServerUpdateHost) {}

  get lastUpdateFailed(): boolean {
    return this.failure.failed;
  }

  isRunning(): boolean {
    return this.state.kind === "running";
  }

  /** What the Status row describes: the run's own state plus what the plugin knows of versions. */
  input(server: string | null, refused: boolean): ServerUpdateInput {
    return {
      own: this.host.ownVersion(),
      server,
      refused,
      updating: this.isRunning(),
      lastUpdateFailed: this.failure.failed,
    };
  }

  /** hello_ack: refresh the job's state, and say once per plugin version that it can update. */
  async serverVersionReported(serverVersion: string): Promise<void> {
    await this.refreshJob();
    const own = this.host.ownVersion();
    const settings = this.host.settings();
    if (!noticeDue({ own, server: serverVersion, seenVersion: settings.updateNoticeVersion })) {
      return;
    }
    // Remembered on show, not on click: a dismissed notice does not come back every launch.
    settings.updateNoticeVersion = own;
    void this.host.saveSettings();
    this.showNotice();
  }

  /** Re-read the job's heartbeat and last result: the dialog and row both depend on them. */
  async refreshJob(): Promise<void> {
    const { serverUrl, deviceToken } = this.host.settings();
    const status = await fetchUpdateStatus(serverUrl, deviceToken)
      .catch((e) => {
        // Unreachable keeps what we knew; the row offers the update that finds out.
        log.warn("server update status failed", { error: formatError(e) });
        return null;
      });
    if (status === null) return;
    this.jobInstalled = status.installed;
    this.failure = noteJobStatus(this.failure, status.result);
    this.host.onChange();
  }

  /** The dialog: confirm (or command when no host job), then admin token, then the run. */
  prompt(): void {
    // A run is going: reopen it. Resetting to idle here would orphan it (no polling, no
    // "Updating the server." on the row) and leave a second request one click away.
    if (this.state.kind !== "running") {
      this.state = this.jobInstalled === false
        ? {
          kind: "done",
          outcome: { text: UPDATE_NO_JOB, showCommand: true, showWhatsNew: true },
        }
        : { kind: "idle" };
    }
    this.openModal();
  }

  /** One dialog for the whole run: the token prompt closes over it, then progress opens it again. */
  private openModal(): void {
    this.modal?.close();
    this.modal = new ServerUpdateModal(this.host.app, this);
    this.modal.open();
  }

  /** Confirmed: the session's admin token first, then the request. */
  confirm(): void {
    this.modal?.close();
    withAdminToken(
      {
        app: this.host.app,
        serverUrl: this.host.settings().serverUrl,
        getAdminToken: () => this.host.adminToken(),
        setAdminToken: (token) => this.host.setAdminToken(token),
      },
      { title: UPDATE_TOKEN_TITLE, message: UPDATE_TOKEN_MESSAGE },
      (token) => void this.run(token),
    );
  }

  /** The dialog was closed: the run keeps going and the row says so. */
  modalClosed(modal: ServerUpdateModal): void {
    if (this.modal === modal) this.modal = null;
  }

  copyCommand(): void {
    void navigator.clipboard.writeText(SERVER_UPDATE_COMMAND)
      .then(() => new Notice("Copied to clipboard."))
      .catch(() => new Notice("Copy failed."));
  }

  /** Plugin unload: the run belongs to the session, so its timer and dialog go with it. */
  dispose(): void {
    if (this.timer !== null) windowGlobal.clearTimeout(this.timer);
    this.timer = null;
    this.modal?.close();
    this.modal = null;
    // A poll already awaiting its reads belongs to the session this unload ends.
    this.state = { kind: "idle" };
  }

  private async run(adminToken: string): Promise<void> {
    this.requestEpoch = 0;
    this.state = { kind: "running" };
    this.openModal();
    let epoch: number;
    try {
      epoch = (await requestServerUpdate(this.host.settings().serverUrl, adminToken)).epoch;
    } catch (e) {
      // A rotated admin token answers 401: drop it and ask again rather than ending the run.
      if (isAdminAuthFailure(e)) {
        this.host.setAdminToken(null);
        this.state = { kind: "idle" };
        this.confirm();
        return;
      }
      log.warn("server update request failed", { error: formatError(e) });
      this.finish(notRun());
      return;
    }
    this.requestEpoch = epoch;
    this.postedAt = Date.now();
    this.lastResultAt = this.postedAt;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    this.timer = windowGlobal.setTimeout(() => void this.poll(), POLL_MS);
  }

  /** One tick: the job's state, the server's version, then the result, a deadline, or another tick. */
  private async poll(): Promise<void> {
    this.timer = null;
    if (this.state.kind !== "running") return;
    const { serverUrl, deviceToken } = this.host.settings();
    // Both tolerate the restart: a failed read is one missed tick, not an error.
    const status = await fetchUpdateStatus(serverUrl, deviceToken).catch(() => null);
    const version = await fetchServerVersion(serverUrl).catch(() => null);
    // An unload or a reopened run during those reads ends the run this tick belongs to.
    if (this.state.kind !== "running") return;
    if (status?.result) {
      this.failure = {
        ...this.failure,
        lastResultEpoch: Math.max(this.failure.lastResultEpoch, status.result.epoch),
      };
    }
    const result = freshResult(status, this.requestEpoch);
    if (result !== null) this.lastResultAt = Date.now();
    // The word is final, but the line names the version the server runs now: without one the
    // tick waits, and the deadline below still ends the wait.
    if (result !== null && result.word !== "running" && version !== null) {
      this.finish(updateOutcome(result.word, version), result.word, result.epoch, version);
      return;
    }
    const now = Date.now();
    if (
      updateExpired({ sincePostMs: now - this.postedAt, sinceResultMs: now - this.lastResultAt })
    ) {
      this.finish(notRun());
      return;
    }
    this.schedulePoll();
  }

  private finish(
    outcome: UpdateOutcome,
    word?: string,
    resultEpoch?: number,
    version?: string,
  ): void {
    if (outcome.showCommand) {
      this.failure = noteUpdateFailure(this.failure, this.requestEpoch);
    } else if (word === "updated" || word === "up-to-date") {
      this.failure = noteUpdateSuccess(this.failure, resultEpoch ?? 0);
    }
    this.state = { kind: "done", outcome };
    this.repaint();
    if (version && (word === "updated" || word === "up-to-date")) {
      this.host.onUpdated(word, version);
    }
    // The heartbeat and the result both moved: the row's control follows.
    void this.refreshJob();
  }

  private repaint(): void {
    this.modal?.render();
    this.host.onChange();
  }

  /** The one time notice: opens the dialog (confirm when job is installed, command when not). */
  private showNotice(): void {
    const notice = new Notice(UPDATE_NOTICE, 0);
    const cta = notice.containerEl
      .createDiv({ cls: "notice-button-container" })
      .createDiv({ cls: "notice-cta", text: UPDATE_BUTTON });
    cta.addEventListener("click", () => {
      notice.hide();
      this.prompt();
    });
  }
}
