import { App as ObsidianApp, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { httpBase } from "../plumbing/scheme.ts";
import {
  reconnectNotice,
  type ServerAddressCheck,
  serverAddressCheckMessage,
  serverAddressError,
  validateServerUrl,
} from "../plumbing/server-address.ts";

export interface ServerAddressModalHost {
  /** Full URL (with scheme) prefilled into the input. */
  currentUrl: string;
  /** Real server check: reachable AND this vault exists for this device token. */
  check: (url: string) => Promise<ServerAddressCheck>;
  /** Check passed: commit the resolved address (scheme kept) and apply live. */
  onSaved: (resolvedUrl: string) => void;
}

// #424 / #452: server address edit modal. The old address is kept until the
// check passes (rollback model); a failed check keeps the modal open with the
// error inline and Save re-enabled.
export class ServerAddressModal extends Modal {
  private value: string;
  private warnEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveBtn: ButtonComponent | null = null;

  constructor(app: ObsidianApp, private host: ServerAddressModalHost) {
    super(app);
    this.value = host.currentUrl;
  }

  onOpen(): void {
    const c = this.contentEl;
    new Setting(c).setHeading().setName("Change server address");
    new Setting(c)
      .setDesc("Applies to this device only.")
      .addText((t) => {
        t.inputEl.dataset.testid = "geode-server-url-input";
        t.setValue(this.value);
        t.onChange((v) => {
          this.value = v;
          this.updateHint(v);
        });
      });
    this.warnEl = c.createDiv({ cls: "geode-warn" });
    this.errorEl = c.createDiv({ cls: "geode-error" });
    // Hint once for the prefilled value so an http:// address warns on open.
    this.updateHint(this.value);
    new Setting(c)
      .addButton((b) => {
        b.setButtonText("Cancel");
        b.buttonEl.dataset.testid = "geode-server-cancel";
        b.onClick(() => this.close());
      })
      .addButton((b) => {
        this.saveBtn = b;
        b.setCta().setButtonText("Save");
        b.buttonEl.dataset.testid = "geode-server-save";
        b.onClick(() => void this.save());
      });
  }

  // Live hint as you type: an http:// URL gets the https warning (the error
  // line clears so the hint never lingers once the field is fixed).
  private updateHint(v: string): void {
    this.errorEl?.setText("");
    this.warnEl?.setText(
      v.trim().toLowerCase().startsWith("http://")
        ? "Use https:// unless the server is on your local network."
        : "",
    );
  }

  private async save(): Promise<void> {
    const url = this.value.trim();
    const issue = validateServerUrl(url);
    if (issue !== "ok") {
      this.errorEl?.setText(serverAddressError(issue));
      return;
    }
    this.errorEl?.setText("");
    this.warnEl?.setText("");
    this.saveBtn?.setButtonText("Checking server…").setDisabled(true);
    const check = await this.host.check(url);
    if (check !== "ok") {
      // Check failed: old address kept, Save re-enabled so the URL can be fixed.
      this.saveBtn?.setButtonText("Save").setDisabled(false);
      this.errorEl?.setText(serverAddressCheckMessage(check, url));
      return;
    }
    this.host.onSaved(httpBase(url));
    new Notice(reconnectNotice(url));
    this.close();
  }
}
