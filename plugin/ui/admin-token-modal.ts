import { App, Modal, Setting } from "obsidian";
import { listVaults } from "../plumbing/provisioning-client.ts";

// #433/#677: the privileged-action gate: the admin token is asked for once per
// Obsidian session, kept in memory (never persisted), validated against the server
// before it is used. Shared by device revoke and an in-floor trash purge.

export type AdminTokenHost = {
  app: App;
  serverUrl: string;
  getAdminToken: () => string | null;
  setAdminToken: (token: string | null) => void;
};

export type AdminTokenAsk = {
  title: string;
  message: string;
  /** The prompt was dismissed without a token: the caller shows its plain message. */
  onCancel?: () => void;
};

/** Run `onOk` with the session's admin token, asking for it when it is not cached. */
export function withAdminToken(
  host: AdminTokenHost,
  ask: AdminTokenAsk,
  onOk: (token: string) => void,
): void {
  const cached = host.getAdminToken();
  if (cached) {
    onOk(cached);
    return;
  }
  new AdminTokenModal(host, ask, onOk).open();
}

class AdminTokenModal extends Modal {
  private accepted = false;

  constructor(
    private host: AdminTokenHost,
    private ask: AdminTokenAsk,
    private onOk: (token: string) => void,
  ) {
    super(host.app);
    this.modalEl.addClass("geode-admin-token-modal");
  }

  onOpen(): void {
    this.setTitle(this.ask.title);
    const c = this.contentEl;
    c.createEl("p", { cls: "geode-admin-token-note", text: this.ask.message });
    let inputEl!: HTMLInputElement;
    new Setting(c)
      .setName("Admin token")
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.placeholder = "Admin token";
        t.inputEl.dataset.testid = "geode-admin-token-input";
        inputEl = t.inputEl;
      });
    const errorEl = c.createEl("p", { cls: "geode-error" });
    const submit = (): void => {
      const token = inputEl?.value.trim() ?? "";
      if (!token) return;
      void listVaults(this.host.serverUrl, token)
        .then(() => {
          this.accepted = true;
          this.host.setAdminToken(token);
          this.close();
          this.onOk(token);
        })
        .catch(() => errorEl.setText("That admin token isn't valid."));
    };
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setCta().setButtonText("Continue");
        b.buttonEl.dataset.testid = "geode-admin-token-continue";
        b.onClick(submit);
      });
    inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    inputEl?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.accepted) this.ask.onCancel?.();
  }
}
