import { assertEquals } from "@std/assert";
import {
  disposeSession,
  startUnlockedSession,
  type SyncSessionHost,
} from "../../../plugin/session.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../../plugin/plumbing/settings-types.ts";
import type { VaultKeys } from "../../../core/crypto.ts";

// #424 live-apply seam: applyServerAddress = new serverUrl in settings +
// startUnlockedSession again. The transport must target the NEW address and
// the sync cursor must survive the restart (persisted state file).

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

function makeHost(): SyncSessionHost {
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
    settings,
    manifest: { version: "0.0.0-test" },
    app: {
      vault: vault as unknown as SyncSessionHost["app"]["vault"],
      workspace: { onLayoutReady: (cb: () => void) => cb() },
    },
    pluginDataPath: (name: string) => `data/${name}`,
    statusBar: null,
    setSyncingProgress: () => {},
    transport: null,
    syncManager: null,
    state: null,
    eventHandler: null,
    deferredStartCleanup: null,
    onVaultNameResolved: () => {},
    onBlocked: () => {},
    onSyncCycleClean: () => {},
    notify: () => {},
    isMobile: false,
  };
}

Deno.test({
  name: "session-live-apply - session restart targets the new address and keeps the cursor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const host = makeHost();
      await startUnlockedSession(host);
      assertEquals(FakeWebSocket.instances.length, 1);
      assertEquals(FakeWebSocket.instances[0].url, "wss://old-host:1111/vaults/v1/sync");

      // Contiguous advances, as a real replay streams them.
      for (let seq = 1; seq <= 7; seq++) host.state?.advanceSyncCursor(seq);
      // applyServerAddress awaits saveSettings() (real async I/O) before the
      // restart; the fake adapter is synchronous, so give the fire-and-forget
      // cursor write its gap explicitly.
      await new Promise((r) => setTimeout(r, 0));

      // #424 live apply: the new address lands in settings, the session restarts.
      host.settings.serverUrl = "new-host:2222";
      await startUnlockedSession(host);

      assertEquals(FakeWebSocket.instances.length, 2);
      assertEquals(FakeWebSocket.instances[1].url, "wss://new-host:2222/vaults/v1/sync");
      assertEquals(host.state?.getSyncCursor(), 7);
      disposeSession(host);
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
  },
});
