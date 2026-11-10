import { assertEquals, assertRejects } from "@std/assert";
import { rebuildVault } from "../../../plugin/sync/rebuild-flow.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";

// #54: a resync that dies disposes the runtime (that is the rebuild's first step), so a
// failure that only rethrows leaves sync stopped until a reload. The catch must restart
// the session on the rows the rebuild rebuilt, never on the ones it disposed.

type Host = Parameters<typeof rebuildVault>[0];

type Fake = {
  host: Host;
  restartCalls: (StateDB | undefined)[];
  settings: PluginSettings;
};

function makeHost(): Fake {
  const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), vaultId: "vault-1" };
  const restartCalls: (StateDB | undefined)[] = [];
  const host = {
    keys: { enc_key: new Uint8Array(32), mac_key: new Uint8Array(32) } as unknown,
    pluginSettings: settings,
    manifest: { version: "1.0.0" },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          readBinary: () => Promise.reject(new Error("no state file")),
          writeBinary: () => Promise.resolve(),
          rename: () => Promise.resolve(),
        },
      },
      workspace: { onLayoutReady: () => {} },
    },
    pluginDataPath: (name: string) => `.obsidian/plugins/geode/${name}`,
    statusBar: null,
    state: null,
    transport: null,
    syncManager: null,
    eventHandler: null,
    deferredStartCleanup: null,
    activity: null,
    isUnlocked: true,
    lastBackupAt: 0,
    blockedNoticeShown: false,
    rekeyCursor: null,
    rekeyElsewhere: false,
    settingTab: null,
    saveSettings: () => Promise.resolve(),
    restartUnlockedSession: (state?: StateDB) => {
      restartCalls.push(state);
      return Promise.resolve();
    },
    isMobile: false,
    notify: () => {},
  } as unknown as Host;
  return { host, restartCalls, settings };
}

/** A transport whose head list fails: the rebuild gets past opening the rows and dies. */
function failingTransport(message: string): Parameters<typeof rebuildVault>[1] {
  return {
    getHeads: async function* () {
      throw new Error(message);
    },
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Parameters<typeof rebuildVault>[1];
}

Deno.test("rebuild-flow - a failed rebuild restarts the session on the rebuilt rows", async () => {
  const { host, restartCalls } = makeHost();

  await assertRejects(
    () => rebuildVault(host, failingTransport("server went away")),
    Error,
    "server went away",
  );

  assertEquals(restartCalls.length, 1, "sync must run again after a failed resync");
  // The rows it restarts on are the reconstructed state, not the disposed instance's.
  assertEquals(restartCalls[0]?.getAllLocalFiles() instanceof Map, true);
});

Deno.test("rebuild-flow - a failed rejoin keeps its pause and stays stopped", async () => {
  const { host, restartCalls, settings } = makeHost();

  await assertRejects(
    () => rebuildVault(host, failingTransport("server went away"), { rejoin: true }),
    Error,
    "server went away",
  );

  assertEquals(restartCalls.length, 0, "a failed rejoin must not restart the old rows");
  assertEquals(settings.rejoinIncomplete, true);
  assertEquals(settings.pauseAt > 0, true);
});
