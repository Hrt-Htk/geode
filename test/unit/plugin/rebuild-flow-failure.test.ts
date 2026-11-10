import { assertEquals, assertRejects } from "@std/assert";
import { rebuildVault } from "../../../plugin/sync/rebuild-flow.ts";
import { MASS_DELETE_NEEDS_RESUME } from "../../../plugin/sync/mass-delete-hold.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";

// #54: a resync disposes the runtime as its first step, so a failure has to be answered.
// A failure BEFORE the head list is read can restart the session on the persisted rows
// (exactly what a normal start reads). A failure AFTER that may have left rows open whose
// files were never restored: a session on them would read the missing files as deletes
// (the mass-delete guard stays silent below 20 files), so sync stays stopped instead.

type Host = Parameters<typeof rebuildVault>[0];

type Fake = {
  host: Host;
  restartCalls: (StateDB | undefined)[];
  settings: PluginSettings;
  /** "write:<file>" per state write, "save" per settings write: their order is the point. */
  events: string[];
};

function makeHost(): Fake {
  const settings: PluginSettings = { ...structuredClone(DEFAULT_SETTINGS), vaultId: "vault-1" };
  const restartCalls: (StateDB | undefined)[] = [];
  const events: string[] = [];
  const host = {
    keys: { enc_key: new Uint8Array(32), mac_key: new Uint8Array(32) } as unknown,
    pluginSettings: settings,
    manifest: { version: "1.0.0" },
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          readBinary: () => Promise.reject(new Error("no state file")),
          writeBinary: (path: string) => {
            events.push(`write:${path.split("/").pop()}`);
            return Promise.resolve();
          },
          rename: () => Promise.resolve(),
          list: () => Promise.resolve({ files: [], folders: [] }),
          stat: () => Promise.resolve(null),
        },
        getAllLoadedFiles: () => [],
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
    saveSettings: () => {
      events.push("save");
      return Promise.resolve();
    },
    restartUnlockedSession: (state?: StateDB) => {
      restartCalls.push(state);
      events.push("restart");
      return Promise.resolve();
    },
    isMobile: false,
    notify: () => {},
  } as unknown as Host;
  return { host, restartCalls, settings, events };
}

type Transport = NonNullable<Parameters<typeof rebuildVault>[1]>;

/** A transport whose head list fails: the rebuild dies before it reads a single head. */
function headsFail(message: string): Transport {
  return {
    getHeads: async function* () {
      throw new Error(message);
    },
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Transport;
}

/** Heads the rebuild can list but not apply: the loop runs, every head fails. */
function headsGarbage(count: number): Transport {
  return {
    getHeads: async function* () {
      for (let index = 0; index < count; index++) {
        yield {
          path_hash: `hash-${index}`,
          version: 1,
          seq: index + 1,
          enc_metadata: "AAAA",
          chunk_hashes: [],
          deleted: false,
          path_ciphertext: null,
          rename_mark: 0,
        };
      }
    },
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Transport;
}

/** A transport with no heads: the rebuild applies nothing and completes. */
function noHeads(): Transport {
  return {
    getHeads: async function* () {},
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Transport;
}

/** A live session to borrow, for the held-mass-delete path (it reconnects before rebuilding). */
const liveTransport = () =>
  ({
    isLive: () => true,
    stop: () => {},
    retryNow: () => {},
  }) as unknown as NonNullable<Host["transport"]>;

Deno.test("rebuild-flow - a rebuild that never read its heads restarts on the persisted rows", async () => {
  const { host, restartCalls, settings } = makeHost();

  await assertRejects(
    () => rebuildVault(host, headsFail("server went away")),
    Error,
    "server went away",
  );

  assertEquals(restartCalls.length, 1, "sync must run again after a failed resync");
  assertEquals(restartCalls[0]?.getAllLocalFiles() instanceof Map, true);
  // The persisted rows are untouched, so no marker: a normal start opens exactly them.
  assertEquals(settings.resyncStop, "");
});

Deno.test("rebuild-flow - an earlier stop keeps a later failure stopped too", async () => {
  const { host, restartCalls, settings } = makeHost();
  settings.resyncStop = "resync failed for 1 file(s): abc";

  await assertRejects(
    () => rebuildVault(host, headsFail("server still away")),
    Error,
    "server still away",
  );

  // The rows the earlier rebuild left open are still open: no restart may touch them.
  assertEquals(restartCalls.length, 0);
  assertEquals(settings.resyncStop, "server still away");
});

Deno.test("rebuild-flow - a partially applied rebuild persists the stop", async () => {
  const { host, restartCalls, settings } = makeHost();

  await assertRejects(
    () => rebuildVault(host, headsGarbage(3)),
    Error,
    "resync failed for 3 file(s)",
  );

  // A restart here would replay the failed heads as local deletes over the server, and a
  // reload would do the same: the marker keeps every session start off those rows.
  assertEquals(restartCalls.length, 0, "a partially applied rebuild must not restart");
  assertEquals(settings.resyncStop.includes("resync failed for 3 file(s)"), true);
});

Deno.test("rebuild-flow - a held rebuild that dies part way keeps the hold and stays stopped", async () => {
  const { host, restartCalls, settings } = makeHost();
  settings.massDeleteHold = {
    files: [{ path: "a.md", mtime: 1 }],
    totalTracked: 30,
    detectedAt: 5,
  };
  host.transport = liveTransport();

  await assertRejects(
    () => rebuildVault(host, headsGarbage(2)),
    Error,
    "resync failed for 2 file(s)",
  );

  assertEquals(restartCalls.length, 0);
  assertEquals(
    settings.massDeleteHold?.files.length,
    1,
    "the hold stays in force until a rebuild returns",
  );
  assertEquals(settings.resyncStop !== "", true);
});

Deno.test("rebuild-flow - the marker is persisted before the first head is applied", async () => {
  const { host, settings } = makeHost();
  const marksBeforeApply: string[] = [];

  await assertRejects(() =>
    rebuildVault(host, headsGarbage(3), {
      // onProgress runs per head, before that head is applied: a crash there leaves the
      // marker behind, so the next start cannot replay half-restored rows as deletes.
      onProgress: () => marksBeforeApply.push(settings.resyncStop),
    })
  );

  assertEquals(marksBeforeApply.length, 3);
  assertEquals(marksBeforeApply.every((mark) => mark !== ""), true);
});

Deno.test("rebuild-flow - a held paused rebuild is refused before it touches anything", async () => {
  const { host, restartCalls, settings } = makeHost();
  settings.massDeleteHold = {
    files: [{ path: "a.md", mtime: 1 }],
    totalTracked: 30,
    detectedAt: 5,
  };
  settings.pauseAt = Date.now();

  await assertRejects(
    () => rebuildVault(host, headsFail("unused")),
    Error,
    MASS_DELETE_NEEDS_RESUME,
  );

  assertEquals(restartCalls.length, 0);
  assertEquals(settings.massDeleteHold?.files.length, 1);
});

Deno.test("rebuild-flow - the rebuild's own transport is the only live one, and stops first", async () => {
  const held = makeHost();
  held.settings.massDeleteHold = {
    files: [{ path: "a.md", mtime: 1 }],
    totalTracked: 30,
    detectedAt: 5,
  };
  const order: string[] = [];
  held.host.transport = {
    isLive: () => true,
    stop: () => order.push("session-stopped"),
    retryNow: () => {},
  } as unknown as NonNullable<Host["transport"]>;
  const own = {
    stop: () => order.push("own-stopped"),
    getHeads: async function* () {},
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Transport;

  await rebuildVault(held.host, null, {
    createTransport: () => {
      order.push("own-started");
      return own;
    },
  });

  // One handshake at a time: the held delete's reconnect uses the session's transport, and
  // the rebuild starts its own only once that one is stopped.
  assertEquals(order, ["session-stopped", "own-started", "own-stopped"]);

  // The failure path too: nothing may reach the network once the recovery restart runs.
  const failed = makeHost();
  const fails = {
    stop: () => failed.events.push("own-stopped"),
    getHeads: async function* () {
      throw new Error("server went away");
    },
    getBlob: () => Promise.reject(new Error("unused")),
    getVersionChain: () => Promise.resolve([]),
  } as unknown as Transport;
  await assertRejects(
    () =>
      rebuildVault(failed.host, null, {
        createTransport: () => {
          failed.events.push("own-started");
          return fails;
        },
      }),
    Error,
    "server went away",
  );
  const restarted = failed.events.indexOf("restart");
  assertEquals(failed.events.slice(restarted - 1, restarted + 1), ["own-stopped", "restart"]);
});

Deno.test("rebuild-flow - the rebuilt rows are flushed before the stop clears", async () => {
  const { host, settings, events } = makeHost();

  await rebuildVault(host, noHeads());

  // The rows file is on a trailing throttle and the rebuild holds no host.state, so only
  // closing the fresh state flushes it: that write has to land before the marker clears.
  const flushed = events.findIndex((event) => event.startsWith("write:"));
  const cleared = events.lastIndexOf("save");
  assertEquals(flushed >= 0, true, `state write missing: ${events.join(",")}`);
  assertEquals(
    flushed < cleared,
    true,
    `the marker cleared before the rows were durable: ${events.join(",")}`,
  );
  assertEquals(settings.resyncStop, "");
});

Deno.test("rebuild-flow - a completed rebuild whose restart throws leaves no marker", async () => {
  const { host, settings } = makeHost();
  host.restartUnlockedSession = () => Promise.reject(new Error("restart blew up"));

  await assertRejects(() => rebuildVault(host, noHeads()), Error, "restart blew up");

  // The rows are consistent, so the stop must not survive a restart that only failed to
  // start a session: a reload opens a normal session on rebuilt rows.
  assertEquals(settings.resyncStop, "");
});

Deno.test("rebuild-flow - a failed rejoin keeps its pause and stays stopped", async () => {
  const { host, restartCalls, settings } = makeHost();

  await assertRejects(
    () => rebuildVault(host, headsFail("server went away"), { rejoin: true }),
    Error,
    "server went away",
  );

  assertEquals(restartCalls.length, 0, "a failed rejoin must not restart the old rows");
  assertEquals(settings.rejoinIncomplete, true);
  assertEquals(settings.pauseAt > 0, true);
});
