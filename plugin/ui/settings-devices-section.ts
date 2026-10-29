import { Setting } from "obsidian";
import { listDeviceStatus } from "../plumbing/provisioning-client.ts";
import {
  devicesSummaryText,
  ROTATE_ADMIN_TOKEN_DESC,
  ROTATE_ADMIN_TOKEN_NAME,
} from "./device-status.ts";
import { type DevicesViewHost, openDevicesView } from "./devices-view.ts";

// #447: settings Devices section is one summary row "N devices · M behind" +
// [Manage] opening the Devices view. Loads with the device token (no admin
// token), updates the summary text in place (no tab re-render).

const REFRESH_INTERVAL_MS = 30_000;

export function renderSettingsDevicesSection(
  fields: HTMLElement,
  host: DevicesViewHost,
): { dispose: () => void } {
  const row = new Setting(fields).setName("Devices");
  row.settingEl.dataset.testid = "geode-settings-devices-summary";
  const descEl = row.descEl.createSpan({ text: "Loading…" });
  row.addButton((btn) => {
    btn.setButtonText("Manage");
    btn.buttonEl.dataset.testid = "geode-settings-devices-manage";
    btn.onClick(() => openDevicesView(host));
  });

  // #526: help row only (no button): the admin token is rotated server-side.
  const rotateRow = new Setting(fields).setName(ROTATE_ADMIN_TOKEN_NAME).setDesc(
    ROTATE_ADMIN_TOKEN_DESC,
  );
  rotateRow.settingEl.dataset.testid = "geode-settings-rotate-admin-token";

  const refresh = async (): Promise<void> => {
    try {
      const status = await listDeviceStatus(host.serverUrl, host.vaultId, host.deviceToken);
      descEl.setText(
        devicesSummaryText(status.devices.map((d) => ({
          appliedSeq: d.applied_seq,
          headSeq: status.head_seq,
        }))),
      );
    } catch {
      // keep the last-known summary on a failed refresh
    }
  };

  void refresh();
  // #502: register with the plugin so a disable/unload (BRAT reload) clears the timer
  const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  host.registerInterval(timer);
  return { dispose: () => clearInterval(timer) };
}
