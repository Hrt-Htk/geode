import { App, Modal, Notice, Setting } from "obsidian";
import { formatUserError, isAdminAuthFailure } from "../plumbing/errors.ts";
import {
  type DeviceStatus,
  listDeviceStatus,
  renameDeviceSelf,
  revokeDevice,
} from "../plumbing/provisioning-client.ts";
import { withAdminToken } from "./admin-token-modal.ts";
import { deviceDescText, deviceSyncStatus } from "./device-status.ts";
import { validateDeviceName } from "./device-name.ts";
import { confirmRevokeDevice } from "./confirm-copy.ts";
import { ConfirmModal } from "./confirm-modal.ts";

// #433/#447: the unified Devices view (mockup DevicesModal): one row per
// device with a status dot, name, last seen and up-to-date/behind status,
// readable with the device token. Rename is this-device only (device token);
// Revoke is for other rows and needs the admin token (in-memory, once per
// session) plus the #460 confirm. Quiet auto-refresh with a last-known list and
// a one-line stale line on a failed refresh.

const REFRESH_INTERVAL_MS = 5_000;

export type DevicesViewHost = {
  app: App;
  serverUrl: string;
  vaultId: string;
  currentDeviceId: string;
  deviceToken: string;
  adminToken: string | null;
  setAdminToken: (token: string | null) => void;
  onRename: (name: string) => void;
  relativeTime: (epochSeconds: number) => string;
  registerInterval: (id: number) => void;
};

export function openDevicesView(host: DevicesViewHost): void {
  new DevicesModal(host).open();
}

class DevicesModal extends Modal {
  private devices: DeviceStatus[] = [];
  private headSeq = 0;
  private lastRefreshAt = 0;
  private refreshFailed = false;
  private listEl: HTMLElement | null = null;
  private staleEl: HTMLElement | null = null;
  private onlyEl: HTMLElement | null = null;
  private timer: number | null = null;

  constructor(private host: DevicesViewHost) {
    super(host.app);
    this.modalEl.addClass("geode-devices-modal");
    this.modalEl.dataset.testid = "geode-devices-modal";
  }

  onOpen(): void {
    this.setTitle("Devices");
    this.renderShell();
    this.renderList();
    void this.refresh();
    // #502: register with the plugin so a disable/unload (BRAT reload) clears the timer
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.host.registerInterval(this.timer);
  }

  onClose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.contentEl.empty();
  }

  private renderShell(): void {
    const c = this.contentEl;
    c.empty();
    this.staleEl = c.createDiv({ cls: "geode-device-stale geode-hidden" });
    this.listEl = c.createDiv({ cls: "geode-device-list" });
    this.onlyEl = c.createDiv({ cls: "geode-device-only geode-hidden" });
    new Setting(c).addButton((b) => {
      b.setCta().setButtonText("Done");
      b.buttonEl.dataset.testid = "geode-devices-done";
      b.onClick(() => this.close());
    });
  }

  private async refresh(): Promise<void> {
    try {
      const status = await listDeviceStatus(
        this.host.serverUrl,
        this.host.vaultId,
        this.host.deviceToken,
      );
      this.devices = status.devices;
      this.headSeq = status.head_seq;
      this.lastRefreshAt = Date.now();
      this.refreshFailed = false;
    } catch {
      this.refreshFailed = true;
    }
    this.renderList();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    if (this.devices.length === 0 && !this.refreshFailed) {
      list.createDiv({ cls: "geode-device-loading", text: "Loading…" });
      return;
    }
    for (const d of this.devices) this.deviceRow(list, d);
    const stale = this.staleEl;
    if (stale) {
      stale.toggleClass("geode-hidden", !this.refreshFailed);
      stale.setText(
        this.refreshFailed
          ? this.devices.length > 0
            ? `Last updated ${
              this.host.relativeTime(this.lastRefreshAt / 1000)
            }, couldn't reach the server.`
            : "Couldn't reach the server."
          : "",
      );
    }
    this.onlyEl?.toggleClass("geode-hidden", this.devices.length > 1);
    this.onlyEl?.setText("Only this device is connected.");
  }

  private deviceRow(parent: HTMLElement, d: DeviceStatus): void {
    const row = parent.createDiv({ cls: "geode-device-row" });
    row.dataset.testid = "geode-device-row";
    const isCurrent = d.id === this.host.currentDeviceId;
    const status = deviceSyncStatus(d.applied_seq, this.headSeq);
    const dotCls = status === "behind"
      ? "geode-sync-dot-orange"
      : status === "never"
      ? "geode-sync-dot-grey"
      : "geode-sync-dot-green";
    row.createSpan({ cls: `geode-sync-dot geode-device-dot ${dotCls}` });
    const body = row.createDiv({ cls: "geode-device-body" });
    body.createDiv({
      cls: "geode-device-name",
      text: isCurrent ? `${d.name} (this device)` : d.name,
    });
    body.createDiv({
      cls: "geode-device-desc",
      text: deviceDescText(
        { lastSeenAt: d.last_seen_at, appliedSeq: d.applied_seq, headSeq: this.headSeq },
        this.host.relativeTime,
      ),
    });
    if (isCurrent) {
      const btn = row.createEl("button", { text: "Rename", cls: "mod-cta" });
      btn.dataset.testid = "geode-device-rename";
      btn.onClickEvent(() => this.renameDevice(d));
    } else {
      const btn = row.createEl("button", { text: "Revoke", cls: "mod-warning" });
      btn.dataset.testid = "geode-device-revoke";
      btn.onClickEvent(() => this.revokeDevice(d));
    }
  }

  private renameDevice(d: DeviceStatus): void {
    new RenameDeviceModal(this.host.app, d.name, async (name) => {
      await renameDeviceSelf(
        this.host.serverUrl,
        this.host.vaultId,
        this.host.deviceToken,
        d.id,
        name,
      );
      this.host.onRename(name);
      new Notice("Geode: device renamed");
      await this.refresh();
    }).open();
  }

  private revokeDevice(d: DeviceStatus): void {
    // Admin-token gate: asked once per session, kept in memory (never persisted).
    withAdminToken(
      {
        app: this.host.app,
        serverUrl: this.host.serverUrl,
        getAdminToken: () => this.host.adminToken,
        setAdminToken: this.host.setAdminToken,
      },
      {
        title: "Admin token required",
        message:
          `Enter the admin token to revoke "${d.name}". Not saved, asked again next session.`,
      },
      (token) => {
        new ConfirmModal(this.host.app, {
          ...confirmRevokeDevice(d.name),
          onConfirm: async () => {
            try {
              await revokeDevice(this.host.serverUrl, token, this.host.vaultId, d.id);
              new Notice("Geode: device revoked");
              await this.refresh();
            } catch (error) {
              // #677: a rotated admin token answers 401: drop it so the next Revoke asks again.
              if (isAdminAuthFailure(error)) this.host.setAdminToken(null);
              new Notice(`Geode: ${formatUserError(error)}`);
            }
          },
        }).open();
      },
    );
  }
}

// #330/#447: rename-device pop-up: prefilled + auto-selected, inline validation,
// "Renaming…" working state, Notice + row refresh on success.
class RenameDeviceModal extends Modal {
  constructor(
    app: App,
    private currentName: string,
    private onRename: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename device");
    const inputEl = this.contentEl.createEl("input", { type: "text", value: this.currentName });
    inputEl.dataset.testid = "geode-device-rename-input";
    const errorEl = this.contentEl.createEl("p", { cls: "geode-error" });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        b.setCta().setButtonText("Rename");
        b.buttonEl.dataset.testid = "geode-device-rename-confirm";
        b.onClick(() => {
          const v = validateDeviceName(inputEl.value);
          if (!v.ok) {
            errorEl.setText(v.error);
            return;
          }
          errorEl.setText("");
          b.setButtonText("Renaming…").setDisabled(true);
          void this.onRename(v.name)
            .then(() => this.close())
            .catch((error) => {
              errorEl.setText(formatUserError(error));
              b.setButtonText("Rename").setDisabled(false);
            });
        });
      });
    inputEl.focus();
    inputEl.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
