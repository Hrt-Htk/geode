import { assertEquals } from "@std/assert";
import {
  disposeSession,
  startUnlockedSession,
  type SyncSessionHost,
  type SyncSessionStatusBar,
} from "../../../plugin/session.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";
import type { VaultKeys } from "../../../core/crypto.ts";

// #523/#420: handlePassDone is source-aware: only a drain "sync" clears the
// applying progress; only an outbound commit ack stamps lastAck.

const realWebSocket = globalThis.WebSocket;

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType: string = "arraybuffer";
  constructor(public url: string, _protocols?: string | string[]) {
    super();
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== 3) {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      }
    }, 0);
  }
  send(_data: string | ArrayBufferLike): void {}
  close(): void {
    this.readyState = 3;
  }
}

function makeStatusBar(): SyncSessionStatusBar & { calls: string[]; progress: unknown } {
  const calls: string[] = [];
  let progress: { current: number; total: number } | null = null;
  return {
    calls,
    get progress() {
      return progress;
    },
    updateDirty: () => calls.push("dirty"),
    clearSyncingProgress: () => {
      progress = null;
      calls.push("clearProgress");
    },
    updateLastSync: () => calls.push("lastSync"),
    updateLastAck: () => calls.push("lastAck"),
    updateSyncingProgress: (c, t) => {
      progress = { current: c, total: t };
      calls.push("progress");
    },
    updatePending: () => calls.push("pending"),
    updateDropped: () => calls.push("dropped"),
    updateRetries: () => calls.push("retries"),
    updateConflicts: () => calls.push("conflicts"),
    updateState: () => calls.push("state"),
    setMassDeleteHold: () => calls.push("holdState"),
    updateReconnectDelay: () => calls.push("reconnect"),
    clearOffline: () => calls.push("clearOffline"),
  };
}

function makeHost(sb: SyncSessionStatusBar & { calls: string[] }): SyncSessionHost {
  const files = new Map<string, Uint8Array>();
  const adapter = {
    readBinary: (p: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`no such file: ${p}`);
      return b;
    },
    writeBinary: (p: string, d: Uint8Array) => {
      files.set(p, d);
    },
    rename: (from: string, to: string) => {
      const b = files.get(from);
      if (!b) throw new Error(`no such file: ${from}`);
      files.set(to, b);
      files.delete(from);
    },
    remove: (p: string) => {
      files.delete(p);
    },
  };
  const vault = {
    on: () => {},
    off: () => {},
    adapter,
    configDir: ".obsidian",
    getAllLoadedFiles: () => [],
  };
  const settings: PluginSettings = {
    ...DEFAULT_SETTINGS,
    serverUrl: "old-host:1111",
    vaultId: "v1",
    deviceId: "d1",
    deviceToken: "tok",
    salt: "c2FsdA==",
  };
  return {
    keys: {} as VaultKeys,
    pluginSettings: settings,
    manifest: { version: "0.0.0-test" },
    app: {
      vault: vault as unknown as SyncSessionHost["app"]["vault"],
      workspace: { onLayoutReady: (cb: () => void) => cb() },
    },
    pluginDataPath: (name: string) => `data/${name}`,
    statusBar: sb,
    setSyncingProgress: () => {},
    transport: null,
    syncManager: null,
    state: null,
    eventHandler: null,
    deferredStartCleanup: null,
    onVaultNameResolved: () => {},
    onBlocked: () => {},
    onMassDeleteHold: () => {},
    onSyncCycleClean: () => {},
    notify: () => {},
    isMobile: false,
  };
}

Deno.test({
  name:
    "session-passdone - only the drain's own sync clears applying progress; only a commit ack stamps the hold",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const sb = makeStatusBar();
      const host = makeHost(sb);
      await startUnlockedSession(host);
      // The session registered handleSyncStatus as the sync-manager's handler.
      const emit = (host.syncManager as { onStatusUpdate: (s: string, d?: unknown) => void })
        .onStatusUpdate.bind(host.syncManager);

      // A catch-up drain is in flight (applying progress set)…
      emit("applying", { current: 3, total: 7 });
      assertEquals(sb.progress, { current: 3, total: 7 });

      // …a commit pass completes mid-drain. It must NOT clear the progress,
      // and it IS an outbound ack: lastAck + lastSync stamp.
      sb.calls.length = 0;
      emit("sync");
      assertEquals(
        sb.calls.includes("clearProgress"),
        false,
        "commit pass must not clear applying progress mid-drain (#523)",
      );
      assertEquals(sb.calls.includes("lastAck"), true, "clean commit pass acks");
      assertEquals(sb.calls.includes("lastSync"), true);
      assertEquals(sb.progress, { current: 3, total: 7 }, "progress still shown");

      // The drain completes: progress clears, lastSync stamps, but no lastAck
      // (inbound work is not an outbound commit ack).
      sb.calls.length = 0;
      emit("sync", { drain: true });
      assertEquals(sb.calls.includes("clearProgress"), true, "drain completion clears progress");
      assertEquals(sb.progress, null);
      assertEquals(sb.calls.includes("lastAck"), false, "drain is not an outbound ack");
      assertEquals(sb.calls.includes("lastSync"), true);

      // A failed commit pass (requeued ops) stamps neither: no green for work
      // that didn't reach the server.
      sb.calls.length = 0;
      emit("sync", { failed: true });
      assertEquals(sb.calls.includes("lastAck"), false, "failed pass must not stamp the hold");
      assertEquals(sb.calls.includes("lastSync"), false, "failed pass must not stamp last sync");

      // A live inbound apply is not an outbound ack either.
      sb.calls.length = 0;
      emit("sync", { apply: true });
      assertEquals(sb.calls.includes("lastAck"), false, "inbound apply is not an outbound ack");
      assertEquals(sb.calls.includes("lastSync"), true);

      disposeSession(host);
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
  },
});

Deno.test({
  name: "session-passdone - an idle pass refreshes the backup stamp but never the ack hold",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const sb = makeStatusBar();
      const host = makeHost(sb);
      await startUnlockedSession(host);
      // The fake socket never answers the hello, so the real transport is stuck
      // in "connecting"; swap in a live one so the backup gate can fire.
      host.transport = {
        getState: () => "live",
        stop: () => {},
        reportAppliedSeq: () => {},
      } as unknown as NonNullable<SyncSessionHost["transport"]>;
      let cleanCycles = 0;
      host.onSyncCycleClean = () => cleanCycles++;
      const emit = (host.syncManager as { onStatusUpdate: (s: string, d?: unknown) => void })
        .onStatusUpdate.bind(host.syncManager);

      // An idle pass (empty reconciler cycle / clean connect drain) on a live,
      // clean vault: it refreshes "last backup" and lastSync, but it is NOT an
      // outbound ack: the green hold must not start on a connect (#420).
      sb.calls.length = 0;
      emit("sync", { idle: true });
      assertEquals(cleanCycles, 1, "idle pass must refresh the last-backup stamp");
      assertEquals(sb.calls.includes("lastSync"), true, "idle pass still stamps last sync");
      assertEquals(sb.calls.includes("lastAck"), false, "idle pass must not start the green hold");

      disposeSession(host);
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
  },
});

Deno.test({
  name:
    "session-passdone - an ack that leaves user work pending does not start the green hold (#420)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const sb = makeStatusBar();
      const host = makeHost(sb);
      await startUnlockedSession(host);
      // The user's unflushed edit is pending: the event handler has an op.
      const realHandler = host.eventHandler;
      (host as unknown as { eventHandler: unknown }).eventHandler = {
        getPendingOps: () => [{ path: "notes/edit.md", kind: "commit", scheduledAt: 0 }],
        stop: () => realHandler?.stop(),
      };
      const emit = (host.syncManager as { onStatusUpdate: (s: string, d?: unknown) => void })
        .onStatusUpdate.bind(host.syncManager);

      // A background (reconciler) commit pass acks, but user work is still
      // pending: the hold must NOT start: showing green would falsely claim
      // the user's change reached the server.
      sb.calls.length = 0;
      emit("sync");
      assertEquals(
        sb.calls.includes("lastAck"),
        false,
        "ack with pending user work must not stamp the hold",
      );
      assertEquals(sb.calls.includes("lastSync"), true, "a clean pass still stamps last sync");

      disposeSession(host);
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
  },
});
