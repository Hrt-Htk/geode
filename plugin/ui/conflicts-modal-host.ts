// #432: the Conflicts modal wiring: builds the modal deps from the live
// session (vault scan, state, keys, transport, activity) and runs a resolution
// through the normal commit path. Kept out of main.ts so the plugin entry stays
// lean.

import { App } from "obsidian";
import { StateDB } from "../plumbing/state.ts";
import { VaultKeys } from "../../core/crypto.ts";
import { Transport } from "../sync/transport.ts";
import { toUint8Array } from "../plumbing/bytes.ts";
import { countConflictFiles } from "../sync/conflict-list.ts";
import { deviceNameMap } from "../plumbing/provisioning-client.ts";
import type { ActivityEntry, ActivityInput } from "../sync/activity-log.ts";
import { buildConflictRows, type ConflictRow } from "../sync/conflict-list.ts";
import {
  executeResolution,
  planResolution,
  type ResolutionAction,
  resolutionLabel,
} from "../sync/conflict-resolve.ts";
import { ConflictsModal } from "./conflicts-modal.ts";

/** The slice of the plugin the conflicts wiring needs (structural). */
export type ConflictsHost = {
  app: App;
  pluginSettings: {
    serverUrl: string;
    vaultId: string;
    deviceToken: string;
    deviceName: string;
    deviceId: string;
  };
  state: StateDB | null;
  keys: VaultKeys | null;
  transport: Transport | null;
  isUnlocked: boolean;
  activity: { entries: Map<string, ActivityEntry>; record: (input: ActivityInput) => void } | null;
  syncManager: {
    handleConflict: (path: string, head: { path_hash: string; version: number }) => Promise<void>;
    onConflictFileDeleted: (path: string) => void;
  } | null;
  statusBar: { updateConflicts: (n: number) => void } | null;
  registerEvent(ref: unknown): unknown;
};

/** #432: the conflict badge derives from the conflict files present in the vault
 * (the same list the modal shows), on every device; vault events keep it live as
 * files appear/disappear: a received conflict file, a surfaced one, a
 * resolution, or a manual delete all re-count and re-render the icon, menu
 * label and settings row together. */
export function wireConflictCount(host: ConflictsHost): void {
  const refresh = () =>
    host.statusBar?.updateConflicts(countConflictFiles(host.app.vault.getAllLoadedFiles()));
  host.registerEvent(host.app.vault.on("create", refresh));
  host.registerEvent(host.app.vault.on("delete", refresh));
  host.registerEvent(host.app.vault.on("rename", refresh));
  refresh();
}

export function openConflictsModal(host: ConflictsHost): void {
  if (!host.isUnlocked || !host.state || !host.keys || !host.transport) return;
  const state = host.state;
  const keys = host.keys;
  const transport = host.transport;
  const adapter = statAdapter(host.app);
  new ConflictsModal(host.app, {
    loadRows: (deviceNames) =>
      buildConflictRows({
        files: () => host.app.vault.getAllLoadedFiles(),
        stat: adapter.stat,
        state,
        keys,
        transport,
        deviceName: host.pluginSettings.deviceName,
        deviceId: host.pluginSettings.deviceId,
        activity: host.activity?.entries ?? new Map<string, ActivityEntry>(),
        deviceNames,
      }),
    resolve: (row, action) => resolveConflict(host, row, action, state, keys, transport, adapter),
    deviceName: () => host.pluginSettings.deviceName,
    remoteNames: () =>
      deviceNameMap(
        host.pluginSettings.serverUrl,
        host.pluginSettings.vaultId,
        host.pluginSettings.deviceToken,
      ),
  }).open();
}

/** The vault-adapter shim shared by row building and resolution. */
function statAdapter(app: App) {
  const stat = async (path: string) => {
    const s = await app.vault.adapter.stat(path);
    return { size: s?.size ?? 0, mtime: s?.mtime ?? 0 };
  };
  return {
    readBinary: async (path: string) => toUint8Array(await app.vault.adapter.readBinary(path)),
    writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) =>
      app.vault.adapter.writeBinary(path, data.slice().buffer, opts),
    stat,
    remove: (path: string) => app.vault.adapter.remove(path),
    exists: (path: string) => app.vault.adapter.exists(path),
  };
}

// One activity line per resolution; the count update rides on the commit
// queue's conflict-file-deleted hook.
async function resolveConflict(
  host: ConflictsHost,
  row: ConflictRow,
  action: ResolutionAction,
  state: StateDB,
  keys: VaultKeys,
  transport: Transport,
  adapter: ReturnType<typeof statAdapter>,
): Promise<string | null> {
  const keptPath = await executeResolution(planResolution(row, action), {
    vault: { adapter },
    state,
    keys,
    transport,
    onConflict: (path, head) => host.syncManager?.handleConflict(path, head) ?? Promise.resolve(),
    onConflictFileDeleted: (path) => host.syncManager?.onConflictFileDeleted(path),
  });
  host.activity?.record({
    path: row.path,
    kind: "resolved",
    label: resolutionLabel(action, host.pluginSettings.deviceName, row.theirs.device),
  });
  return keptPath;
}
