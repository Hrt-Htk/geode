import { App, Modal, Setting } from "obsidian";
import { formatError, log } from "../plumbing/log.ts";

export class ExportModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  constructor(app: App, private onSubmit: (dir: string) => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Export decrypted vault");
    const { contentEl } = this;

    new Setting(contentEl)
      .setName("Folder path")
      .addText((t) => {
        this.inputEl = t.inputEl;
        t.inputEl.setAttribute("data-testid", "geode-export-folder-input");
        t.setPlaceholder("/path/to/export/folder");
        t.inputEl.addEventListener("keyup", (evt) => {
          if (evt.key === "Enter") void this.submit();
        });
      });

    this.errorEl = contentEl.createEl("p", {
      text: "",
      attr: { style: "color: var(--text-error); font-size: 12px; margin: 4px 0" },
    });

    new Setting(contentEl).addButton((b) => {
      this.submitBtn = b.buttonEl;
      b.buttonEl.setAttribute("data-testid", "geode-export-submit");
      b.setCta().setButtonText("Export");
      b.onClick(() => this.submit());
    });

    this.inputEl?.focus();
  }

  private async submit(): Promise<void> {
    if (!this.inputEl) return;
    const dir = this.inputEl.value.trim();
    if (!dir) {
      if (this.errorEl) {
        (this.errorEl as unknown as { setText(t: string): void }).setText(
          "Folder path is required.",
        );
      }
      return;
    }
    this.setWorking(true);
    try {
      this.close();
      await this.onSubmit(dir);
    } catch (error) {
      log.error("vault export failed", { error: formatError(error) });
    } finally {
      this.setWorking(false);
    }
  }

  private setWorking(on: boolean): void {
    if (!this.submitBtn) return;
    this.submitBtn.textContent = on ? "Working…" : "Export";
    this.submitBtn.disabled = on;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
