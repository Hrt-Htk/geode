import { assertEquals } from "@std/assert";
import { restartUnlockedSession } from "../../../plugin/plumbing/vault-lock.ts";
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
    pluginDataPath: (name: string) => {
      paths.push(name);
      return `.obsidian/plugins/geode/${name}`;
    },
    statusBar: { setStoppedResync: (reason: string) => calls.push(`stopped:${reason}`) },
    app: {
      vault: {
        adapter: { readBinary: () => Promise.reject(new Error("no state file")) },
      },
      workspace: { onLayoutReady: () => {} },
    },
  } as unknown as Host;
}

Deno.test("vault-lock - a resync marker keeps the session stopped and shows the stop", async () => {
  const calls: string[] = [];
  await restartUnlockedSession(
    makeHost({ resyncIncomplete: true, resyncStopMessage: REASON }, calls),
  );
  assertEquals(calls, [`stopped:${REASON}`]);
});

Deno.test("vault-lock - without the marker no stop is shown", async () => {
  const calls: string[] = [];
  await restartUnlockedSession(makeHost({}, calls));
  assertEquals(calls, []);
});
