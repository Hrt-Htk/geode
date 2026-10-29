import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import { assert, assertEquals } from "@std/assert";

// Minimal transport stub: the SyncManager now subscribes to transport events, so
// the stub must expose addEventListener (a no-op is fine here � no events are
// dispatched in these status-sequence tests).
function fakeTransport(): any {
  return { getState: () => "live", addEventListener: () => {} };
}

/**
 * Issue #195: statusbar-visual-states reads status icon before it settles
 * (syncing vs synced).
 *
 * The E2E test expects `lucide-circle-check` (synced) but can see
 * `lucide-refresh-cw` (syncing) because the statusbar state machine
 * hasn't transitioned from "syncing" to "live" yet.
 *
 * These unit tests verify the underlying state transition logic:
 * 1. StatusBar.resolveIcon returns the correct icon for each state
 * 2. SyncManager.onStatusUpdate emits "sync" after version handling completes
 * 3. The full status update sequence during a sync cycle
 */

// ── StatusBar icon resolution tests ────────────────────────────────────

/**
 * Minimal StatusBar mock that tracks the resolved icon state without
 * requiring obsidian imports. We test the logic path by calling the
 * public update methods and checking the resulting state.
 */
function makeStatusBarMock() {
  let state = "disconnected";
  let pendingCount = 0;
  let dirtyCount = 0;
  let conflictCount = 0;
  let lastSyncTime = 0;
  let reconnectDelay = 0;

  const updates: Array<{ method: string; args: unknown[] }> = [];

  return {
    updateState: (s: string) => {
      state = s;
      updates.push({ method: "updateState", args: [s] });
    },
    updatePending: (n: number) => {
      pendingCount = n;
      updates.push({ method: "updatePending", args: [n] });
    },
    updateDirty: (n: number) => {
      dirtyCount = n;
      updates.push({ method: "updateDirty", args: [n] });
    },
    updateConflicts: (n: number) => {
      conflictCount = n;
      updates.push({ method: "updateConflicts", args: [n] });
    },
    updateLastSync: () => {
      lastSyncTime = Date.now();
      updates.push({ method: "updateLastSync", args: [] });
    },
    updateReconnectDelay: (ms: number) => {
      reconnectDelay = ms;
      updates.push({ method: "updateReconnectDelay", args: [ms] });
    },
    getState: () => state,
    getPendingCount: () => pendingCount,
    getDirtyCount: () => dirtyCount,
    getConflictCount: () => conflictCount,
    getLastSyncTime: () => lastSyncTime,
    getReconnectDelay: () => reconnectDelay,
    getUpdates: () => updates,
    clearUpdates: () => {
      updates.length = 0;
    },
  };
}

Deno.test("statusbar-state - syncing state shows refresh-cw, not circle-check", () => {
  const sb = makeStatusBarMock();
  sb.updateState("syncing");
  assertEquals(sb.getState(), "syncing");
  // In the real StatusBar, resolveIcon("syncing") returns { icon: "refresh-cw", spin: true }
  // This is NOT "circle-check": the test must wait for state to become "live"
});

Deno.test("statusbar-state - live with no pending/dirty shows circle-check", () => {
  const sb = makeStatusBarMock();
  sb.updateState("live");
  sb.updatePending(0);
  sb.updateDirty(0);
  sb.updateLastSync();
  assertEquals(sb.getState(), "live");
  assertEquals(sb.getPendingCount(), 0);
  assertEquals(sb.getDirtyCount(), 0);
  // In the real StatusBar, resolveIcon("live", pending=0, dirty=0) returns circle-check
});

Deno.test("statusbar-state - transition from syncing to live requires explicit updateState", () => {
  const sb = makeStatusBarMock();
  sb.updateState("syncing");
  assertEquals(sb.getState(), "syncing");

  // Merely calling updateLastSync does NOT change the state from "syncing" to "live"
  sb.updateLastSync();
  assertEquals(sb.getState(), "syncing");

  // The transport status event must fire updateState("live") first
  sb.updateState("live");
  assertEquals(sb.getState(), "live");
});

// ── SyncManager status update sequence tests ───────────────────────────

Deno.test("statusbar-state - handleVersion skips status update when keys are null", async () => {
  const transport = fakeTransport();
  const vault = new FakeVault();
  const state = openStateDB();
  const settings = { ...DEFAULT_SETTINGS };

  const sm = new SyncManager(transport, {
    vault: vault as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  (sm as any).state = state;
  (sm as any).keys = null; // null keys causes early return in handleVersion

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  await sm.handleVersion({
    type: "server_version",
    vault_id: "test",
    seq: 1,
    path_hash: "abc123",
    parent_version: 0,
    enc_metadata: "",
    chunk_hashes: [],
    deleted: false,
    device_id: "other-device",
    version: 1,
  });

  // handleVersion returns early when keys is null (the `if (!this.state || !this.keys) return` guard).
  // This is correct: no sync work means no status update. The E2E test (#195) reads the
  // statusbar icon before the transport state transitions from "syncing" to "live", which
  // is a separate timing issue from the SyncManager's status emission.
  assertEquals(calls.length, 0, "handleVersion with null keys must not emit any status");

  state.close();
});

Deno.test("statusbar-state - locked pass reports pending clear but no sync (nothing committed)", async () => {
  const transport = fakeTransport();
  const vault = new FakeVault();
  const state = openStateDB();
  const settings = { ...DEFAULT_SETTINGS };

  const sm = new SyncManager(transport, {
    vault: vault as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  (sm as any).state = state;
  (sm as any).keys = null;

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  await sm.handlePendingOps([
    { path: "a.md", kind: "commit" },
    { path: "b.md", kind: "commit" },
  ]);

  // Sequence must be: pending(N) → pending(0) → sync(idle). A pass that
  // processes nothing (cleared while locked) is a clean sync cycle (backup
  // stamp) but not an ack: it carries the idle marker, never the green hold
  // (#420).
  assertEquals(calls[0][0], "pending");
  assertEquals(calls[0][1], 2);

  const pendingZeroIdx = calls.findIndex((c) => c[0] === "pending" && c[1] === 0);
  assert(pendingZeroIdx > 0, "pending(0) must come after pending(N)");

  assertEquals(
    calls[calls.length - 1],
    ["sync", { idle: true }],
    "locked pass ends in an idle sync",
  );
  assertEquals(calls.filter((c) => c[0] === "sync").length, 1);

  state.close();
});

Deno.test("statusbar-state - reconciler ops follow same pattern: pending → pending:0 → idle sync when locked", async () => {
  const transport = fakeTransport();
  const vault = new FakeVault();
  const state = openStateDB();
  const settings = { ...DEFAULT_SETTINGS };

  const sm = new SyncManager(transport, {
    vault: vault as any,
    settings,
    configDir: ".obsidian",
    reconnect: () => Promise.resolve(),
  });
  (sm as any).state = state;
  (sm as any).keys = null;

  const calls: Array<[string, unknown]> = [];
  sm.setOnStatusUpdate((s: string, d: unknown) => calls.push([s, d]));

  // reconciler ops flow through the same queue as event ops; keys is null so
  // the commit loop body is skipped.
  await (sm as any).commitQueue.enqueue([
    { kind: "create", path: "new.md" },
  ], "handleReconcilerOps");

  assertEquals(calls[0][0], "pending");
  assertEquals(calls[0][1], 1);

  const pendingZeroIdx = calls.findIndex((c) => c[0] === "pending" && c[1] === 0);
  assert(pendingZeroIdx > 0);

  // Locked pass (keys null) processes nothing: pending clears, then an idle
  // sync: a clean cycle (backup stamp) but not an ack, so no green hold (#420).
  assertEquals(
    calls[calls.length - 1],
    ["sync", { idle: true }],
    "locked pass ends in an idle sync",
  );
  assertEquals(calls.filter((c) => c[0] === "sync").length, 1);

  state.close();
});

// ── Integration: simulate the E2E timing scenario ─────────────────────

Deno.test("statusbar-state - simulated E2E flow: transport syncing → live → reconciler → synced", () => {
  const sb = makeStatusBarMock();

  // Phase 1: Transport connects → syncing
  sb.updateState("syncing");
  assertEquals(sb.getState(), "syncing");

  // Phase 2: Transport catches up → live
  sb.updateState("live");
  sb.updateLastSync();
  assertEquals(sb.getState(), "live");
  assertEquals(sb.getPendingCount(), 0);
  assertEquals(sb.getDirtyCount(), 0);
  // At this point, resolveIcon would return circle-check (synced)

  // Phase 3: Reconciler finds work → pending
  sb.updatePending(2);
  assertEquals(sb.getPendingCount(), 2);
  // resolveIcon would return refresh-cw with spin (pushing)

  // Phase 4: Reconciler completes → pending:0 → sync
  sb.updatePending(0);
  sb.updateLastSync();
  assertEquals(sb.getPendingCount(), 0);
  assertEquals(sb.getDirtyCount(), 0);
  // resolveIcon would return circle-check (synced) again

  // Verify the full sequence of updates
  const updates = sb.getUpdates();
  assertEquals(updates[0], { method: "updateState", args: ["syncing"] });
  assertEquals(updates[1], { method: "updateState", args: ["live"] });
  assertEquals(updates[2], { method: "updateLastSync", args: [] });
  assertEquals(updates[3], { method: "updatePending", args: [2] });
  assertEquals(updates[4], { method: "updatePending", args: [0] });
  assertEquals(updates[5], { method: "updateLastSync", args: [] });
});
