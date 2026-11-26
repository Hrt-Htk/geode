import { App, Modal, setIcon, Setting } from "obsidian";
import type { ServerUpdate } from "./server-update.ts";
import {
  GEODE_RELEASES_URL,
  SERVER_UPDATE_COMMAND,
  UPDATE_CONFIRM_LINES,
  UPDATE_COPY,
  UPDATE_DONE,
  UPDATE_PROGRESS,
  UPDATE_TITLE_ASK,
  UPDATE_TITLE_RUN,
  UPDATE_WHATS_NEW,
  type UpdateOutcome,
} from "./server-update-logic.ts";

/** Append a standard external link anchor with a testid. */
export function appendExternalLink(
  container: HTMLElement,
  text: string,
  url: string,
  testid: string,
): void {
  const link = container.createEl("a", {
    text,
    href: url,
    cls: "external-link",
    attr: { target: "_blank", rel: "noopener noreferrer" },
  });
  link.dataset.testid = testid;
}

/** #44/#51: one dialog from question to outcome: confirm, progress, then one result line (or
 * the command directly when the host job is not installed). */
export class ServerUpdateModal extends Modal {
  constructor(app: App, private updater: ServerUpdate) {
    super(app);
    this.modalEl.addClass("geode-confirm");
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.updater.modalClosed(this);
  }

  render(): void {
    const state = this.updater.state;
    this.titleEl.setText(state.kind === "idle" ? UPDATE_TITLE_ASK : UPDATE_TITLE_RUN);
    this.contentEl.empty();
    if (state.kind === "idle") this.renderConfirm();
    else if (state.kind === "running") this.renderProgress();
    else this.renderResult(state.outcome);
  }

  private renderConfirm(): void {
    const box = this.contentEl.createDiv({ cls: "geode-confirm-modal" });
    for (const line of UPDATE_CONFIRM_LINES) box.createEl("p", { text: line });
    appendExternalLink(
      box.createEl("p"),
      UPDATE_WHATS_NEW,
      GEODE_RELEASES_URL,
      "geode-update-whats-new",
    );
    new Setting(box)
      .addButton((btn) => {
        btn.setButtonText("Cancel");
        btn.buttonEl.dataset.testid = "geode-update-cancel";
        btn.onClick(() => this.close());
      })
      .addButton((btn) => {
        // The accent colour, not destructive: updating is the wanted action.
        btn.setCta().setButtonText("Update server");
        btn.buttonEl.dataset.testid = "geode-update-confirm";
        btn.onClick(() => this.updater.confirm());
      });
  }

  private renderProgress(): void {
    const line = this.contentEl.createDiv({ cls: "geode-update-progress" });
    line.dataset.testid = "geode-update-progress";
    setIcon(line.createSpan({ cls: "geode-update-progress-icon" }), "loader-circle");
    line.createSpan({ text: UPDATE_PROGRESS });
  }

  private renderResult(outcome: UpdateOutcome): void {
    const box = this.contentEl.createDiv({ cls: "geode-confirm-modal" });
    box.createEl("p", { text: outcome.text });
    if (outcome.showWhatsNew) {
      appendExternalLink(
        box.createEl("p"),
        UPDATE_WHATS_NEW,
        GEODE_RELEASES_URL,
        "geode-update-whats-new",
      );
    }
    if (outcome.showCommand) {
      this.contentEl.createDiv({ cls: "geode-code-row" })
        .createEl("code", { text: SERVER_UPDATE_COMMAND });
    }
    const row = new Setting(this.contentEl);
    if (outcome.showCommand) {
      row.addButton((btn) => {
        btn.setButtonText(UPDATE_COPY);
        btn.buttonEl.dataset.testid = "geode-update-copy";
        btn.onClick(() => this.updater.copyCommand());
      });
    }
    row.addButton((btn) => {
      btn.setCta().setButtonText(UPDATE_DONE);
      btn.buttonEl.dataset.testid = "geode-update-done";
      btn.onClick(() => this.close());
    });
  }
}
