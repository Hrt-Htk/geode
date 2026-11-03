import type { Setting } from "obsidian";
import type { SettingsRow } from "./settings-legacy.ts";
import { listDeviceStatus } from "../plumbing/provisioning-client.ts";
import {
  devicesSummaryText,
  ROTATE_ADMIN_TOKEN_DESC,
  ROTATE_ADMIN_TOKEN_NAME,
} from "./device-status.ts";
import { type DevicesViewHost, openDevicesView } from "./devices-view.ts";
import { windowGlobal } from "../plumbing/window.ts";

// #447: settings Devices section is one summary row "N devices · M behind" +
// [Manage] opening the Devices view. Loads with the device token (no admin
// token), updates the summary text in place (no tab re-render).

const REFRESH_INTERVAL_MS = 30_000;

export function settingsDevicesRows(host: DevicesViewHost): SettingsRow[] {
  return [{
    name: "Devices",
    render: (row) => renderDevicesSummary(row, host),
  }, {
    // #526: help row only (no button): the admin token is rotated server-side.
    name: ROTATE_ADMIN_TOKEN_NAME,
    desc: ROTATE_ADMIN_TOKEN_DESC,
    render: (row) => {
      row.settingEl.dataset.testid = "geode-settings-rotate-admin-token";
    },
  }];
}

/** The summary row polls while shown; its cleanup stops the poll (#502). */
function renderDevicesSummary(row: Setting, host: DevicesViewHost): () => void {
  row.settingEl.dataset.testid = "geode-settings-devices-summary";
  const descEl = row.descEl.createSpan({ text: "Loading…" });
  row.addButton((btn) => {
    btn.setButtonText("Manage");
    btn.buttonEl.dataset.testid = "geode-settings-devices-manage";
    btn.onClick(() => openDevicesView(host));
  });

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
  const timer = windowGlobal.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  host.registerInterval(timer);
  return () => windowGlobal.clearInterval(timer);
}
