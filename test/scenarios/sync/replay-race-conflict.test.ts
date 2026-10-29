import { assertEquals } from "@std/assert";
import { FakeVault, startTestServer, waitFor } from "../../two-vault-driver.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { Transport } from "../../../plugin/sync/transport.ts";
import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { VaultEventHandler } from "../../../plugin/sync/events.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

/**
 * Regression test: conflict file created on every login.
 *
 * Root cause: the server sends server_hello_ack before replay messages finish
 * processing on the client. The client fires "live" on hello_ack, which starts
 * the reconciler. The reconciler runs before replay finishes, sees files on disk
 * that aren't in local state yet, and commits them with parent_version=0.
 * The server rejects (parent mismatch), the merge has no ancestor (localVersion=null),
 * and a conflict file is created: even though local == server content.
 *
 * The merge logic bug: when localVersion is null, findAncestor returns null
 * immediately, skipping the content-equality check. Two identical files are
 * treated as irreconcilable.
 */

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function waitForConflictFile(
  vault: FakeVault,
  prefix: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = [...vault.files.keys()].find((p) => p.startsWith(`${prefix} (conflict `));
    if (found) return found;
    await sleep(50);
  }
  return null;
}

// ── Plugin factory ─────────────────────────────────────────────────────

interface TestPluginInternals {
  transport: Transport;
  syncManager: SyncManager;
  eventHandler: VaultEventHandler;
  settings: any;
  saltBytes: Uint8Array;
  deviceId: string;
}

interface TestPluginHandle {
  fakeVault: FakeVault;
  _state: any;
  get state(): any;
  stop: () => void;
  flushPending: () => Promise<void>;
  commitDirect: (path: string) => Promise<void>;
  waitForVersion: (path: string, timeoutMs?: number) => Promise<void>;
}

interface TestPluginResult {
  handle: TestPluginHandle;
  livePromise: Promise<void>;
  _internals: TestPluginInternals;
}

function makePlugin(
  url: string,
  vaultId: string,
  deviceId: string,
  deviceToken: string,
  saltBytes: Uint8Array,
): TestPluginResult {
  const fakeVault = new FakeVault();
  const transport = new Transport();
  const settings = {
    ...DEFAULT_SETTINGS,
    serverUrl: url,
    vaultId,
    deviceId,
    deviceToken,
    salt: b64encode(saltBytes),
  };

  const syncManager = new SyncManager(transport, {
    vault: fakeVault as unknown as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });

  const state: any = null;

  const livePromise = new Promise<void>((resolve) => {
    transport.addEventListener("live", () => resolve());
  });

  transport.addEventListener("version", (e: Event) => {
    syncManager.handleVersion((e as CustomEvent).detail).catch(() => {});
  });

  const eventHandler = new VaultEventHandler(
    {
      on: (name: string, cb: (...args: unknown[]) => void) => {
        if (name === "create") {
          fakeVault.onEvent((evt) => {
            if (evt.type === "create") cb({ path: evt.path });
          });
        } else if (name === "modify") {
          fakeVault.onEvent((evt) => {
            if (evt.type === "modify") cb({ path: evt.path });
          });
        } else if (name === "delete") {
          fakeVault.onEvent((evt) => {
            if (evt.type === "delete") cb({ path: evt.path });
          });
        }
      },
      off: () => {},
      adapter: {
        readJSON: () => null,
        writeJSON: () => {},
      },
    } as any,
    (ops: any[]) => syncManager.handlePendingOps(ops),
    () => true,
  );

  return {
    handle: {
      fakeVault,
      _state: null as any,
      get state() {
        return this._state!;
      },
      stop() {
        eventHandler.stop();
        syncManager.stop();
        state?.close();
        transport.stop();
      },
      async flushPending() {
        eventHandler.flushNow();
        await waitFor(() => syncManager.getPendingOps().length === 0, "commit queue to drain");
      },
      async commitDirect(path: string) {
        await syncManager.handlePendingOps([{ path, kind: "commit" }]);
      },
      async waitForVersion(path: string, timeoutMs = 10_000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const row = this.state.getLocalFile(path);
          if (row && !row.deleted && this.fakeVault.fileExists(path)) return;
          await sleep(50);
        }
        throw new Error(`timeout waiting for version of ${path}`);
      },
    },
    livePromise,
    _internals: { transport, syncManager, eventHandler, settings, saltBytes, deviceId },
  };
}

async function startPlugin(p: TestPluginResult): Promise<void> {
  const { _internals, handle } = p;
  const keys = await deriveKeys("test", _internals.saltBytes, { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  handle._state = state;
  _internals.syncManager.setState(state, keys);
  _internals.syncManager.setOnStatusUpdate(() => {});
  _internals.transport.start(
    _internals.settings.serverUrl,
    _internals.settings.vaultId,
    _internals.deviceId,
    _internals.settings.deviceToken,
    state.getSyncCursor(),
    SERVER_VERSION,
  );
  _internals.eventHandler.start();
  await p.livePromise;
  _internals.syncManager.startReconciler();
}

// ── Test 1: Direct reproduction of the merge bug ──────────────────────

Deno.test({
  name: "replay-race-conflict - commit before replay creates spurious conflict",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer();
    const vaultId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));

    server.db.run(
      "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
      vaultId,
      "test-vault",
      salt,
      Date.now(),
    );

    const deviceIdA = crypto.randomUUID();
    const tokenA = randomToken();
    server.db.run(
      "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
      deviceIdA,
      vaultId,
      "device-A",
      tokenA,
    );

    const deviceIdB = crypto.randomUUID();
    const tokenB = randomToken();
    server.db.run(
      "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
      deviceIdB,
      vaultId,
      "device-B",
      tokenB,
    );

    try {
      // Device A creates a file
      const pA = makePlugin(server.url, vaultId, deviceIdA, tokenA, salt);
      await startPlugin(pA);
      const path = "notes/doc.md";
      const content = "Content from A";
      pA.handle.fakeVault.write(path, content);
      await pA.handle.flushPending();

      // Device B connects and receives the file
      const pB = makePlugin(server.url, vaultId, deviceIdB, tokenB, salt);
      await startPlugin(pB);
      await pB.handle.waitForVersion(path);

      assertEquals(
        new TextDecoder().decode(await pB.handle.fakeVault.readBinary(path)),
        content,
      );
      assertEquals(pB.handle.state.getLocalFile(path).last_seen_version, 1);

      // --- Simulate the exact race condition ---
      // Stop B completely
      pB.handle.stop();

      // Create fresh plugin (fresh in-memory StateDB = cursor=0)
      // But pre-populate vault with the file (simulates persistent disk)
      const pB2 = makePlugin(server.url, vaultId, deviceIdB, tokenB, salt);
      pB2.handle.fakeVault.write(path, content); // file on "disk"

      // Start with empty state
      const keys = await deriveKeys("test", salt, { opsLimit: 1, memLimit: 8192 });
      const freshState = openStateDB();
      pB2.handle._state = freshState;
      pB2._internals.syncManager.setState(freshState, keys);
      pB2._internals.syncManager.setOnStatusUpdate(() => {});

      // Connect: server replays version 1
      pB2._internals.transport.start(
        pB2._internals.settings.serverUrl,
        pB2._internals.settings.vaultId,
        deviceIdB,
        tokenB,
        freshState.getSyncCursor(), // = 0, triggers full replay
        SERVER_VERSION,
      );

      // Wait for hello_ack (live): replay messages are IN FLIGHT but not yet processed
      await pB2.livePromise;

      // DON'T start reconciler or event handler: we manually trigger the commit
      // to simulate the race

      // At this point:
      // - File is on disk (from pre-population)
      // - State is empty (fresh DB, replay not yet processed)
      // - Server has file at version 1

      // Force commit BEFORE replay finishes processing
      // parent_version = null → 0, server head = 1 → conflict
      await pB2.handle.commitDirect(path);

      // Merge resolution is awaited by commitDirect; waitForConflictFile below
      // polls up to 5s for a spurious conflict file to appear.

      // Check for conflict files
      const conflictPath = await waitForConflictFile(pB2.handle.fakeVault, "notes/doc", 5000);

      if (conflictPath) {
        const canonical = new TextDecoder().decode(await pB2.handle.fakeVault.readBinary(path));
        const conflictContent = new TextDecoder().decode(
          await pB2.handle.fakeVault.readBinary(conflictPath),
        );

        assertEquals(
          canonical,
          conflictContent,
          "canonical and conflict content should be identical (spurious conflict)",
        );
        assertEquals(canonical, content, "content should match original");

        throw new Error(
          `BUG REPRODUCED: spurious conflict file '${conflictPath}' created. ` +
            `Local content === server content, but merge returned conflict_file because ` +
            `localVersion was null (no ancestor found). This is the login conflict bug.`,
        );
      }

      console.log("PASS: no spurious conflict file created");
      pB2.handle.stop();
      pA.handle.stop();
    } finally {
      await server.stop();
    }
  },
});

// ── Test 2: Full login cycle: no conflict on repeated logins ─────────

Deno.test({
  name: "replay-race-conflict - repeated login/logout cycles produce no conflicts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const server = await startTestServer();
    const vaultId = crypto.randomUUID();
    const salt = crypto.getRandomValues(new Uint8Array(16));

    server.db.run(
      "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
      vaultId,
      "test-vault",
      salt,
      Date.now(),
    );

    const deviceIdA = crypto.randomUUID();
    const tokenA = randomToken();
    server.db.run(
      "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
      deviceIdA,
      vaultId,
      "device-A",
      tokenA,
    );

    const deviceIdB = crypto.randomUUID();
    const tokenB = randomToken();
    server.db.run(
      "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
      deviceIdB,
      vaultId,
      "device-B",
      tokenB,
    );

    try {
      // A creates a file
      const pA = makePlugin(server.url, vaultId, deviceIdA, tokenA, salt);
      await startPlugin(pA);
      const path = "shared.md";
      const content = "Shared content";
      pA.handle.fakeVault.write(path, content);
      await pA.handle.flushPending();

      // B connects, receives file, disconnects: repeat 3 times
      for (let cycle = 1; cycle <= 3; cycle++) {
        const pB = makePlugin(server.url, vaultId, deviceIdB, tokenB, salt);
        await startPlugin(pB);
        await pB.handle.waitForVersion(path);
        await sleep(500);

        const conflicts = [...pB.handle.fakeVault.files.keys()].filter((p) => isConflictPath(p));
        assertEquals(
          conflicts.length,
          0,
          `Cycle ${cycle}: unexpected conflict files: ${conflicts.join(", ")}`,
        );

        pB.handle.stop();
      }

      pA.handle.stop();
    } finally {
      await server.stop();
    }
  },
});
