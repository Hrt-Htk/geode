import { App, Modal, Setting } from "obsidian";

export interface ConfirmModalOptions {
  title: string;
  message: string;
  confirmText: string;
  /** Default "Cancel". */
  cancelText?: string;
  /** Default true. A non-destructive confirm (restore) keeps the neutral button. */
  warning?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Runs after the dialog closed (confirm, cancel or Escape). */
  onClosed?: () => void;
}

export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("geode-confirm");
    this.titleEl.setText(this.opts.title);
    const { contentEl } = this;

    const container = contentEl.createEl("div", { cls: "geode-confirm-modal" });
    container.createEl("p", { text: this.opts.message });

    new Setting(container).addButton((btn) => {
      btn.setButtonText(this.opts.cancelText ?? "Cancel");
      btn.buttonEl.dataset.testid = "geode-confirm-cancel";
      btn.onClick(() => this.close());
    }).addButton((btn) => {
      // setDestructive() is @since Obsidian 1.13 while the plugin supports 1.8.7; the
      // deprecated setWarning() is the compatible red destructive, so keep it here.
      if (this.opts.warning !== false) btn.setWarning();
      btn.setButtonText(this.opts.confirmText);
      btn.buttonEl.dataset.testid = "geode-confirm-yes";
      btn.onClick(async () => {
        btn.buttonEl.disabled = true;
        try {
          await this.opts.onConfirm();
        } finally {
          this.close();
        }
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.opts.onClosed?.();
  }
}
