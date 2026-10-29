// #520: view and modal openers: trash, devices, conflicts, activity, settings
// tab, passphrase, setup wizard, and the post-setup flow. main.ts keeps thin
// delegations.

import type { App } from "obsidian";
import type { VaultKeys } from "../../core/crypto.ts";
import type { VersionRecord } from "../../core/protocol.ts";
import {
  createVaultFlow as runCreateVaultFlow,
  joinWithAdminFlow as runJoinWithAdminFlow,
} from "../sync/flows.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import type { TrashApi } from "../plumbing/trash-client.ts";
import { deviceNameMap } from "../plumbing/provisioning-client.ts";
import type { ActivityRecorder } from "../sync/activity-log.ts";
import type { RejoinBackup } from "../sync/rejoin.ts";
import { eraseChain } from "../sync/history-fetch.ts";
import type { RestoreOutcome } from "../sync/history-restore.ts";
import type { Transport } from "../sync/transport.ts";
import { type ConflictsHost, openConflictsModal as openConflicts } from "./conflicts-modal-host.ts";
import { openForgotModal } from "./forgot-modal.ts";
import { FileHistoryModal } from "./history-modal.ts";
import { PassphraseModal } from "./passphrase-modal.ts";
import { SetupWizardModal } from "./setup-wizard.ts";
import { TrashModal } from "./trash-modal.ts";
import { MassDeleteModal } from "./mass-delete-modal.ts";
import type { MassDeleteHold } from "../sync/mass-delete-hold.ts";
import { ActivityModal } from "./activity-modal.ts";
import type { StatusBar } from "./statusbar.ts";
import type { SyncStatusInput } from "./sync-status.ts";
import { openDevicesView as openDevicesViewModal } from "./devices-view.ts";
import { relativeTime } from "./trash-format.ts";

/** #583: a window opened at one name, optionally capped at a version. */
type HistoryOpen = { path: string; pathHash?: string; ceiling?: number };

type ModalsHost = {
  app: App;
  manifest: { id: string };
  settings: PluginSettings;
  keys: VaultKeys | null;
  isUnlocked: boolean;
  transport: Transport | null;
  adminToken: string | null;
  activity: ActivityRecorder | null;
  statusBar: StatusBar | null;
  /** #522: the status input the activity footer mirrors. */
  getStatusInput: () => SyncStatusInput;
  setupWizardModal: SetupWizardModal | null;
  /** #464: the single open history modal (a lock closes it: no keys, no decrypt). */
  historyModal: FileHistoryModal | null;
  /** #465: the unlocked sync engine: a restore commits through it. Decides the held
   * mass delete too (#601). */
  syncManager:
    | {
      restoreVersion: (record: VersionRecord, path: string) => Promise<RestoreOutcome>;
      getMassDeleteHold: () => MassDeleteHold | null;
      resolveMassDeleteHold: (deletePaths: string[]) => Promise<void>;
    }
    | null;
  notify: (message: string) => void;
  settingTab: { display(): void; refreshTrashCount(): void } | null;
  trash: TrashApi;
  registerInterval(id: number): unknown;
  saveSettings(): Promise<void>;
  unlockVault(passphrase: string): Promise<void>;
  leaveVault(): Promise<void>;
  startSetupWizard(): void;
  restartUnlockedSession(): Promise<void>;
  createVaultFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultName: string;
    deviceName: string;
    passphrase: string;
    argon2Params?: { ops: number; mem: number };
  }, keepWizardOpen?: boolean): Promise<void>;
  joinWithAdminFlow(opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  }, keepWizardOpen?: boolean): Promise<{ rejoin: RejoinBackup | null }>;
  /** #701: does this join land on an old copy of the same vault? */
  detectRejoin(vaultId: string): Promise<boolean>;
  /** #701: the rejoin rebuild: the server wins, doubtful bytes are set aside. */
  beginRejoinRebuild(): Promise<RejoinBackup | null>;
};

export function openTrashModal(host: ModalsHost): void {
  // #446: trash is a modal (not a side panel): Settings → Trash → [View],
  // the status-bar menu, or the open-trash command. Device names come from
  // the device-token status list; failures keep the neutral "Another device".
  new TrashModal(host.app, {
    trash: host.trash,
    retentionDays: () => host.trash.retentionDays(),
    deviceNames: () =>
      deviceNameMap(host.settings.serverUrl, host.settings.vaultId, host.settings.deviceToken),
    // #583: decision 6: the row's History is capped at the version it was deleted at,
    // so a name reused by another file never shows that file's saves.
    openHistory: (entry) => {
      if (!entry.path) return;
      openHistoryModal(host, {
        path: entry.path,
        pathHash: entry.path_hash,
        ceiling: entry.version,
      });
    },
    // #582: delete forever erases the names the file lived at, so the walk runs
    // before the purge. A locked or stalled client refuses: an erase of the trashed
    // name alone would contradict the confirm. An old server has no chain to send.
    eraseChainFor: (entry) => {
      if (entry.version === undefined) return Promise.resolve([]);
      if (!host.keys || !host.transport) return Promise.reject(new Error("vault locked"));
      return eraseChain(host.transport, host.keys, entry.path_hash, entry.version);
    },
    onChanged: () => host.settingTab?.refreshTrashCount(),
    // #677: a purge inside the server's retention floor needs the admin token, asked
    // for the same way the Devices view's Revoke does.
    adminHost: {
      app: host.app,
      serverUrl: host.settings.serverUrl,
      getAdminToken: () => host.adminToken,
      setAdminToken: (token) => {
        host.adminToken = token;
      },
    },
  }).open();
}

/** #601: the review window: the notice, the status menu and both settings rows open it.
 * It needs the connected sync engine (a held device opens one on demand) and the effective
 * trash retention the Trash window shows. */
export function openMassDeleteReview(host: ModalsHost): void {
  const syncManager = host.syncManager;
  const hold = syncManager?.getMassDeleteHold();
  if (!syncManager || !hold) return;
  new MassDeleteModal(host.app, hold, {
    resolve: (deletePaths) => syncManager.resolveMassDeleteHold(deletePaths),
    notify: (message) => host.notify(message),
    retentionDays: () => host.trash.retentionDays(),
  }).open();
}

/** #433: the status-menu "Devices" entry opens the Devices view (device token, no admin token). */
export function openDevicesView(host: ModalsHost): void {
  openDevicesViewModal({
    app: host.app,
    serverUrl: host.settings.serverUrl,
    vaultId: host.settings.vaultId,
    currentDeviceId: host.settings.deviceId,
    deviceToken: host.settings.deviceToken,
    adminToken: host.adminToken,
    setAdminToken: (token) => {
      host.adminToken = token;
    },
    onRename: (name) => {
      host.settings.deviceName = name;
      void host.saveSettings();
    },
    relativeTime,
    registerInterval: (id) => host.registerInterval(id),
  });
}

/** #432: the status-menu "Conflicts" entry and the settings [Review] open the Conflicts modal. */
export function openConflictsModal(host: ConflictsHost): void {
  openConflicts(host);
}

/** #431: the status-menu / settings entry opens the Sync activity modal. */
export function openActivityModal(host: ModalsHost): void {
  // onload always creates the recorder before any entry point can fire.
  new ActivityModal(
    host.app,
    host.activity!,
    (path) => openHistoryModal(host, { path }),
    () => deviceNameMap(host.settings.serverUrl, host.settings.vaultId, host.settings.deviceToken),
    {
      getStatusInput: () => host.getStatusInput(),
      subscribe: (cb) => host.statusBar!.subscribe(cb),
    },
  ).open();
}

/** #464: one file's history, from the activity row, the file menu, the command,
 * or a trash row (which passes its own path hash and the version it was deleted
 * at, #583). Keys and transport exist only while the vault is unlocked, so the
 * entry points are inert (the file-menu item is not even offered) when locked. */
export function openHistoryModal(host: ModalsHost, open: HistoryOpen): void {
  if (!host.keys || !host.transport || !host.syncManager) return;
  const syncManager = host.syncManager;
  host.historyModal?.close();
  const modal = new FileHistoryModal(host.app, {
    path: open.path,
    pathHash: open.pathHash,
    ceiling: open.ceiling,
    keys: host.keys,
    source: host.transport,
    localDevice: { id: host.settings.deviceId, name: host.settings.deviceName },
    remoteNames: () =>
      deviceNameMap(host.settings.serverUrl, host.settings.vaultId, host.settings.deviceToken),
    // #465: restored at the name the file has NOW, even when the version predates a
    // rename; a trash row's path is the last name, so the file comes back there.
    restore: (record) => syncManager.restoreVersion(record, open.path),
    notify: (message) => host.notify(message),
    onClosed: () => onHistoryClosed(host),
  });
  host.historyModal = modal;
  modal.open();
}

/** Clears the slot from the modal's onClose, so a lock's close() empties it too. */
function onHistoryClosed(host: ModalsHost): void {
  host.historyModal = null;
}

/** #430: the status-menu "Geode settings" entry opens the plugin's settings tab. */
export function openSettingsTab(host: ModalsHost): void {
  const setting = (host.app as unknown as {
    setting: { open: () => void; openTabById: (id: string) => void };
  }).setting;
  setting.open();
  setting.openTabById(host.manifest.id);
}

export function openPassphraseModal(host: ModalsHost): void {
  new PassphraseModal(
    host.app,
    (p) => host.unlockVault(p),
    () => openForgotModal(host, () => openPassphraseModal(host)),
  ).open();
}

// #440: setup wizard, tracked so the forgot flow can replace an open one.
export function startSetupWizard(host: ModalsHost): void {
  host.setupWizardModal?.close();
  (host.setupWizardModal = new SetupWizardModal(host.app, host)).open();
}

// Called from the wizard's onClose (Done, Esc, or click-outside); clears the
// stale ref so a later onVaultConfigured/close never targets a dead modal.
export function onWizardClosed(host: ModalsHost): void {
  host.setupWizardModal = null;
}

export async function createVaultFlow(
  host: ModalsHost,
  opts: {
    serverUrl: string;
    adminToken: string;
    vaultName: string;
    deviceName: string;
    passphrase: string;
    argon2Params?: { ops: number; mem: number };
  },
  keepWizardOpen = false,
): Promise<void> {
  await runCreateVaultFlow(host, opts);
  afterSetupFlow(host, keepWizardOpen);
}

export async function joinWithAdminFlow(
  host: ModalsHost,
  opts: {
    serverUrl: string;
    adminToken: string;
    vaultId: string;
    deviceName: string;
    passphrase: string;
  },
  keepWizardOpen = false,
): Promise<{ rejoin: RejoinBackup | null }> {
  const { rejoin } = await runJoinWithAdminFlow(host, opts, keepWizardOpen);
  afterSetupFlow(host, keepWizardOpen);
  return { rejoin };
}

function afterSetupFlow(host: ModalsHost, keepWizardOpen: boolean): void {
  if (keepWizardOpen) {
    host.settingTab?.display();
  } else {
    onVaultConfigured(host);
  }
}

function onVaultConfigured(host: ModalsHost): void {
  host.setupWizardModal?.close();
  host.setupWizardModal = null;
  host.settingTab?.display();
}
