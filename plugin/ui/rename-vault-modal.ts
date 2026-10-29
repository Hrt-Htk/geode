import { App, Modal, Notice, Setting } from "obsidian";
import { formatUserError } from "../plumbing/errors.ts";
import { renameVaultSelf } from "../plumbing/provisioning-client.ts";
import { validateVaultName } from "./confirm-copy.ts";

export class RenameVaultModal extends Modal {
  constructor(
    app: App,
    private opts: {
      serverUrl: string;
      vaultId: string;
      deviceToken: string;
      currentName: string;
      onRenamed: (name: string) => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename vault");
    const inputEl = this.contentEl.createEl("input", {
      type: "text",
      value: this.opts.currentName,
    });
    inputEl.dataset.testid = "geode-vault-rename-input";
    const errorEl = this.contentEl.createEl("p", { cls: "geode-error" });
    errorEl.dataset.testid = "geode-vault-rename-error";

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((btn) => {
        btn.setCta().setButtonText("Rename");
        btn.buttonEl.dataset.testid = "geode-vault-rename-confirm";
        btn.onClick(() => {
          const result = validateVaultName(inputEl.value);
          if (!result.ok) {
            errorEl.setText(result.error);
            return;
          }
          const name = result.name;
          errorEl.setText("");
          btn.setButtonText("Renaming…").setDisabled(true);
          void (async () => {
            try {
              await renameVaultSelf(
                this.opts.serverUrl,
                this.opts.vaultId,
                this.opts.deviceToken,
                name,
              );
              this.opts.onRenamed(name);
              this.close();
              new Notice("Geode: vault renamed");
            } catch (error: unknown) {
              btn.setButtonText("Rename").setDisabled(false);
              errorEl.setText(formatUserError(error));
            }
          })();
        });
      });

    inputEl.focus();
    inputEl.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
