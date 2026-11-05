import { App, Notice } from "obsidian";
import {
  fetchServerVersion,
  fetchUpdateStatus,
  requestServerUpdate,
} from "../plumbing/update-client.ts";
import { formatError, log } from "../plumbing/log.ts";
import { windowGlobal } from "../plumbing/window.ts";
import { withAdminToken } from "./admin-token-modal.ts";
import { ServerUpdateModal } from "./server-update-modal.ts";
import {
  freshResult,
  noticeDue,
  notRun,
  SERVER_UPDATE_COMMAND,
  UPDATE_BUTTON,
  UPDATE_NOTICE,
  UPDATE_TOKEN_MESSAGE,
  UPDATE_TOKEN_TITLE,
  updateExpired,
  updateOutcome,
  type ServerUpdateInput,
  type UpdateOutcome,
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
  serverUrl: () => string;
  deviceToken: () => string;
  ownVersion: () => string;
  adminToken: () => string | null;
  setAdminToken: (token: string | null) => void;
  seenVersion: () => string;
  rememberSeenVersion: (version: string) => void;
  /** The state changed: re-describe the Status row in place. */
  onChange: () => void;
};

/** #44: runs one server update and reports it. Dialog-scoped state, plugin-scoped run: closing
 * the dialog hides it, the polling and the row keep going. */
export class ServerUpdate {
  state: ServerUpdateState = { kind: "idle" };
  /** A heartbeat younger than three minutes; null until the first read answers. */
  jobInstalled: boolean | null = null;
  private modal: ServerUpdateModal | null = null;
  private timer: number | null = null;
  private requestEpoch = 0;
  private postedAt = 0;
  private lastResultAt = 0;
  private lastVersion: string | null = null;

  constructor(private host: ServerUpdateHost) {}

  isRunning(): boolean {
    return this.state.kind === "running";
  }

  /** What the Status row describes: the run's own state plus what the plugin knows of versions. */
  input(own: string, server: string | null, refused: boolean): ServerUpdateInput {
    return { own, server, refused, jobInstalled: this.jobInstalled, updating: this.isRunning() };
  }

  /** hello_ack: refresh the job's state, and say once per plugin version that it can update. */
  async serverVersionReported(serverVersion: string): Promise<void> {
    await this.refreshJob();
    const own = this.host.ownVersion();
    if (!noticeDue({ own, server: serverVersion, seenVersion: this.host.seenVersion() })) return;
    // Remembered on show, not on click: a dismissed notice does not come back every launch.
    this.host.rememberSeenVersion(own);
    this.showNotice();
  }

  /** Re-read the job's heartbeat: the row's control and the notice both depend on it. */
  async refreshJob(): Promise<void> {
    const status = await fetchUpdateStatus(this.host.serverUrl(), this.host.deviceToken())
      .catch((e) => {
        // Unreachable keeps what we knew; the row offers the update that finds out.
        log.warn("server update status failed", { error: formatError(e) });
        return null;
      });
    if (status === null) return;
    this.jobInstalled = status.installed;
    this.host.onChange();
  }

  /** The dialog: confirm, then the admin token, then the run. Also the notice's action. */
  prompt(): void {
    this.state = { kind: "idle" };
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
        serverUrl: this.host.serverUrl(),
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
  }

  private async run(adminToken: string): Promise<void> {
    this.state = { kind: "running" };
    this.openModal();
    let epoch: number;
    try {
      epoch = (await requestServerUpdate(this.host.serverUrl(), adminToken)).epoch;
    } catch (e) {
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
    // Both tolerate the restart: a failed read is one missed tick, not an error.
    const status = await fetchUpdateStatus(this.host.serverUrl(), this.host.deviceToken())
      .catch(() => null);
    const version = await fetchServerVersion(this.host.serverUrl()).catch(() => null);
    if (version !== null) this.lastVersion = version;
    const result = freshResult(status, this.requestEpoch);
    if (result !== null && result.word !== "running") {
      const now = version ?? this.lastVersion ?? this.host.ownVersion();
      this.finish(updateOutcome(result.word, now));
      return;
    }
    if (result !== null) this.lastResultAt = Date.now();
    const now = Date.now();
    if (
      updateExpired({ sincePostMs: now - this.postedAt, sinceResultMs: now - this.lastResultAt })
    ) {
      this.finish(notRun());
      return;
    }
    this.schedulePoll();
  }

  private finish(outcome: UpdateOutcome): void {
    this.state = { kind: "done", outcome };
    this.repaint();
    // The heartbeat and the result both moved: the row's control follows.
    void this.refreshJob();
  }

  private repaint(): void {
    this.modal?.render();
    this.host.onChange();
  }

  /** The one time notice: the action only when the job can answer it. */
  private showNotice(): void {
    const notice = new Notice(UPDATE_NOTICE, 0);
    if (this.jobInstalled === false) return;
    const cta = notice.containerEl
      .createDiv({ cls: "notice-button-container" })
      .createDiv({ cls: "notice-cta", text: UPDATE_BUTTON });
    cta.addEventListener("click", () => {
      notice.hide();
      this.prompt();
    });
  }
}
