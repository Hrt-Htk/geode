import { App, Modal, Notice, Setting } from "obsidian";
import { formatUserError } from "../plumbing/errors.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { confirmNewVaultFromNotes } from "./confirm-copy.ts";
import {
  FORGOT_CALLOUT_BODY,
  FORGOT_CALLOUT_TITLE,
  FORGOT_DEVICE_HINT,
  FORGOT_GOT_IT,
  FORGOT_NEW_VAULT,
  FORGOT_TITLE,
  FORGOT_TRY_AGAIN,
} from "./passphrase-copy.ts";

type ForgotModalOptions = {
  /** Back to the unlock pop-up; omitted when the caller is already the entry point (wizard). */
  onTryAgain?: () => void;
  /** Leave the vault (local notes untouched) and open the setup wizard. */
  onStartNewVault: () => void | Promise<void>;
};

// #440: the "Forgot your passphrase?" link row, shared by the unlock pop-up,
// the locked settings tab, and the wizard Join step.
export function createForgotLink(
  parent: HTMLElement,
  testid: string,
  onClick: () => void,
): HTMLElement {
  const row = new Setting(parent);
  const link = row.nameEl.createEl("a", { text: FORGOT_TITLE, href: "#" });
  link.dataset.testid = testid;
  link.onClickEvent((e) => {
    e.preventDefault();
    onClick();
  });
  return row.settingEl;
}

// #440: honest forgot-passphrase modal: no one can reset it, check other
// devices first, or start a new vault from the local notes (confirm family).
class ForgotModal extends Modal {
  constructor(app: App, private opts: ForgotModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(FORGOT_TITLE);
    const { contentEl } = this;

    const callout = contentEl.createDiv({
      cls: "callout callout-note",
      attr: { "data-testid": "geode-forgot-callout" },
    });
    const title = callout.createDiv({ cls: "callout-title" });
    title.createDiv({ cls: "callout-icon" });
    title.createDiv({ cls: "callout-title-inner", text: FORGOT_CALLOUT_TITLE });
    callout.createDiv({ cls: "callout-content", text: FORGOT_CALLOUT_BODY });

    contentEl.createEl("p", {
      cls: "geode-forgot-hint",
      text: FORGOT_DEVICE_HINT,
      attr: { "data-testid": "geode-forgot-hint" },
    });

    new Setting(contentEl)
      .addButton((b) => {
        b.setCta().setButtonText(FORGOT_GOT_IT);
        b.buttonEl.dataset.testid = "geode-forgot-got-it";
        b.onClick(() => this.close());
      })
      .addButton((b) => {
        b.setButtonText(FORGOT_TRY_AGAIN);
        b.buttonEl.dataset.testid = "geode-forgot-try-again";
        b.onClick(() => {
          this.close();
          this.opts.onTryAgain?.();
        });
      });

    new Setting(contentEl).addButton((b) => {
      b.setWarning().setButtonText(FORGOT_NEW_VAULT);
      b.buttonEl.dataset.testid = "geode-forgot-new-vault";
      b.onClick(() => {
        new ConfirmModal(this.app, {
          ...confirmNewVaultFromNotes(),
          onConfirm: () => {
            this.close();
            void Promise.resolve(this.opts.onStartNewVault()).catch((error) => {
              new Notice(`Geode: ${formatUserError(error)}`);
            });
          },
        }).open();
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// #440: flow host: the destructive path is the existing leave path (local
// notes untouched) followed by the setup wizard.
export type ForgotFlowHost = {
  app: App;
  leaveVault: () => Promise<void>;
  startSetupWizard: () => void;
};

export function openForgotModal(host: ForgotFlowHost, onTryAgain?: () => void): void {
  new ForgotModal(host.app, {
    onTryAgain,
    onStartNewVault: async () => {
      await host.leaveVault();
      host.startSetupWizard();
    },
  }).open();
}
