// #744: leaveVault disposed the runtime (which flushes the armed local-files
// throttle and always persists the cursor) and then deleted the state files
// without waiting for those writes: their rename landed after the remove, so a
// "fully unconfigured" vault kept local-files.json. Assert the leave drains the
// in-flight writes before it deletes.

import { assertEquals } from "@std/assert";
import { openSessionState } from "../../../plugin/session.ts";
import { leaveVault } from "../../../plugin/plumbing/vault-lock.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

type Host = Parameters<typeof leaveVault>[0];

/** Every adapter op yields macrotasks. A state write (temp write + rename
 *  through the FS bridge) outlives the leave's revoke round trip, which is what
 *  reorders the write against the delete. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const slow = async (ticks: number) => {
  for (let i = 0; i < ticks; i++) await tick();
};

function makeAdapter(files: Map<string, Uint8Array>) {
  return {
    readBinary: async (path: string): Promise<ArrayBuffer> => {
      await tick();
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    },
    writeBinary: async (path: string, data: Uint8Array): Promise<void> => {
      await slow(3);
      files.set(path, new Uint8Array(data));
    },
    rename: async (from: string, to: string): Promise<void> => {
      await slow(2);
      const data = files.get(from);
      if (!data) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, data);
    },
    remove: async (path: string): Promise<void> => {
      await tick();
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
    },
  };
}

function makeHost(files: Map<string, Uint8Array>): Host {
  return {
    keys: null,
    isUnlocked: true,
    lastBackupAt: 0,
    blockedNoticeShown: false,
    rekeyCursor: null,
    rekeyElsewhere: false,
    settingTab: { applyLockState: () => {}, display: () => {} },
    statusBar: null,
    activity: null,
    transport: null,
    syncManager: null,
    state: null,
    eventHandler: null,
    deferredStartCleanup: null,
    settings: { ...DEFAULT_SETTINGS, vaultId: "vault-1", deviceToken: "tok", deviceId: "dev" },
    manifest: { version: "0.0.0" },
    app: {
      vault: { adapter: makeAdapter(files), configDir: ".obsidian" },
      workspace: { onLayoutReady: () => {} },
      saveLocalStorage: () => {},
      loadLocalStorage: () => null,
    },
    pluginDataPath: (name: string) => name,
    setSyncingProgress: () => {},
    onVaultNameResolved: () => {},
    onHelloRekey: () => {},
    onBlocked: () => {},
    onMassDeleteHold: () => {},
    onServerVersion: () => {},
    onSyncCycleClean: () => {},
    saveSettings: async () => {},
    notify: () => {},
    isMobile: false,
    restartUnlockedSession: async () => {},
  } as unknown as Host;
}

Deno.test("leaveVault - the leave drains the state writes its own teardown starts", async () => {
  const files = new Map<string, Uint8Array>();
  const host = makeHost(files);
  const state = await openSessionState(host);
  host.state = state;
  // Arms the 2 s local-files throttle, so the teardown flushes it on close().
  state.upsertLocalFile({
    path: "note.md",
    path_hash: "hash-note",
    size: 5,
    mtime: 1,
    plaintext_hash: "plain",
    last_seen_version: 1,
    chunk_hashes: [],
  });

  await leaveVault(host);

  assertEquals(
    files.has("local-files.json"),
    false,
    "local-files.json must be gone after the leave",
  );
  assertEquals(
    files.has("sync-cursor.json"),
    false,
    "sync-cursor.json must be gone after the leave",
  );
});
