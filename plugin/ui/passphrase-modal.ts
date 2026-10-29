import { App, Modal, Setting } from "obsidian";
import { createForgotLink } from "./forgot-modal.ts";
import {
  PASSPHRASE_REQUIRED,
  UNLOCK_TITLE,
  UNLOCK_WORKING,
  WRONG_PASSPHRASE,
} from "./passphrase-copy.ts";

export class PassphraseModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private onSubmit: (passphrase: string) => void | Promise<void>,
    private onForgot: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(UNLOCK_TITLE);
    const { contentEl } = this;

    new Setting(contentEl)
      .setName("Passphrase")
      .addText((t) => {
        this.inputEl = t.inputEl;
        t.inputEl.dataset.testid = "geode-passphrase-input";
        t.inputEl.type = "password";
        t.setPlaceholder("Passphrase");
        t.inputEl.addEventListener("keyup", (evt) => {
          if (evt.key === "Enter") void this.submit();
        });
      });

    // #440: forgot link under the field, above the CTA row.
    createForgotLink(contentEl, "geode-passphrase-forgot", () => {
      this.close();
      this.onForgot();
    });

    this.errorEl = contentEl.createEl("p", {
      cls: "geode-passphrase-error",
      text: "",
      attr: {
        style: "color: var(--text-error); font-size: 12px; margin: 4px 0; min-height: 1em",
        "data-testid": "geode-passphrase-error",
      },
    });

    new Setting(contentEl).addButton((b) => {
      this.submitBtn = b.buttonEl;
      this.submitBtn.dataset.testid = "geode-passphrase-submit";
      b.setCta().setButtonText("Unlock");
      b.onClick(() => this.submit());
    });

    this.inputEl?.focus();
  }

  private showError(msg: string): void {
    if (this.errorEl) (this.errorEl as unknown as { setText(t: string): void }).setText(msg);
  }

  private setWorking(on: boolean): void {
    if (!this.submitBtn) return;
    this.submitBtn.textContent = on ? UNLOCK_WORKING : "Unlock";
    this.submitBtn.disabled = on;
  }

  private async submit(): Promise<void> {
    if (this.submitBtn?.disabled) return;
    if (!this.inputEl) return;
    const value = this.inputEl.value;
    if (!value) {
      this.showError(PASSPHRASE_REQUIRED);
      return;
    }
    this.showError("");
    this.setWorking(true);
    try {
      await this.onSubmit(value);
      this.close();
    } catch {
      this.showError(WRONG_PASSPHRASE);
      this.inputEl.value = "";
      this.inputEl.focus();
    } finally {
      this.setWorking(false);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
