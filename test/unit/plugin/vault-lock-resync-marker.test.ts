import { assertEquals } from "@std/assert";
import {
  disposeRuntime,
  enterRekeyLockedState,
  restartUnlockedSession,
} from "../../../plugin/plumbing/vault-lock.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";

// #54: a resync that died after it may have changed rows persists a marker. While it is
// set, a reload or an unlock must not open a session on those rows (the files it never
// restored would read as deletes); it lands on the stopped state instead.

const REASON = "resync failed for 2 file(s): aa, bb";

type Host = Parameters<typeof restartUnlockedSession>[0];

function makeHost(
  settings: Partial<PluginSettings>,
  calls: string[],
  paths: string[] = [],
): Host {
  return {
    pluginSettings: { ...structuredClone(DEFAULT_SETTINGS), ...settings },
    keys: {},
    isUnlocked: true,
    syncEpoch: 0,
    blockedNoticeShown: false,
    transport: null,
    state: null,
    syncManager: null,
    eventHandler: null,
    deferredStartCleanup: null,
    onMassDeleteHold: (hold: { files: unknown[] }) => calls.push(`hold:${hold.files.length}`),
    pluginDataPath: (name: string) => {
      paths.push(name);
      return `.obsidian/plugins/geode/${name}`;
    },
    statusBar: {
      setStoppedResync: (reason: string) => calls.push(`stopped:${reason}`),
      updateState: () => {},
      updatePending: () => {},
      updateDirty: () => {},
      setVersionStatus: () => {},
      setMassDeleteHold: () => {},
    },
    app: {
      saveLocalStorage: () => {},
      vault: {
        adapter: { readBinary: () => Promise.reject(new Error("no state file")) },
      },
      workspace: { onLayoutReady: () => {} },
    },
  } as unknown as Host;
}

Deno.test("vault-lock - a resync marker keeps the session stopped and shows the stop", async () => {
  const calls: string[] = [];
  await restartUnlockedSession(makeHost({ resyncStop: REASON }, calls));
  assertEquals(calls, [`stopped:${REASON}`]);
});

Deno.test("vault-lock - a held delete is still announced behind a resync marker", async () => {
  const calls: string[] = [];
  await restartUnlockedSession(
    makeHost(
      {
        resyncStop: REASON,
        massDeleteHold: { files: [{ path: "a.md", mtime: 1 }], totalTracked: 3, detectedAt: 5 },
      },
      calls,
    ),
  );
  assertEquals(calls, ["hold:1", `stopped:${REASON}`]);
});

Deno.test("vault-lock - a teardown ends the resync epoch unless the run owns it", () => {
  const calls: string[] = [];
  const host = makeHost({}, calls);
  disposeRuntime(host, { clearKeys: false, updateStatus: true });
  assertEquals(host.syncEpoch, 1, "lock, leave and unload end the run");
  disposeRuntime(host, { clearKeys: false, updateStatus: true, keepEpoch: true });
  assertEquals(host.syncEpoch, 1, "the rebuild's own teardown does not");
});

Deno.test("vault-lock - a re-key lock ends the run's epoch too", () => {
  const calls: string[] = [];
  const host = makeHost({}, calls);
  enterRekeyLockedState(host);
  assertEquals(host.rekeyElsewhere, true);
  assertEquals(host.syncEpoch, 1, "the run it may have had is over");
});

Deno.test("vault-lock - without the marker no stop is shown", async () => {
  const calls: string[] = [];
  await restartUnlockedSession(makeHost({}, calls));
  assertEquals(calls, []);
});
