// #701: the join's mode decision.

import { loadPersistedState } from "../plumbing/state-persistence.ts";

export interface JoinPlanInput {
  /** The vault this device was configured for before the join ("" = none). */
  previousVaultId: string;
  /** The vault being joined. */
  vaultId: string;
  /** Rows in the old row table (open or closed): what this device last agreed on. */
  rowCount: number;
  /** The old cursor: the last server seq this device applied. */
  cursor: number;
}

/** A rejoin needs the same vault AND old state. Without the state, a join over a folder
 * of unrelated notes is a first join and still uploads them; with it, the folder is an
 * old copy of this vault (the row table and the cursor fail independently, so either one
 * is enough). */
export function isRejoin(input: JoinPlanInput): boolean {
  const sameVault = input.previousVaultId !== "" && input.previousVaultId === input.vaultId;
  if (!sameVault) return false;
  return input.rowCount > 0 || input.cursor > 0;
}

/** Where the old state lives and the login time it was written at. */
type JoinStateHost = {
  pluginSettings: { vaultId: string };
  pluginDataPath(name: string): string;
  app: { vault: { adapter: { readBinary(path: string): Promise<ArrayBuffer> } } };
};

/** Does this join land on an old copy of the vault? Read the state files the join is
 * about to reuse: before it overwrites the settings that name the old vault. */
export async function detectRejoin(host: JoinStateHost, vaultId: string): Promise<boolean> {
  const { persisted, persistedCursor } = await loadPersistedState(
    (path) => host.app.vault.adapter.readBinary(path),
    {
      localFiles: host.pluginDataPath("local-files.json"),
      cursor: host.pluginDataPath("sync-cursor.json"),
    },
  );
  return isRejoin({
    previousVaultId: host.pluginSettings.vaultId,
    vaultId,
    rowCount: persisted?.length ?? 0,
    cursor: persistedCursor ?? 0,
  });
}
