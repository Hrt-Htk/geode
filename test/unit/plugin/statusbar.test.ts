import { type IconInput, resolveIcon } from "../../../plugin/ui/statusbar-icon.ts";
import type { VersionStatus } from "../../../plugin/sync/version-state.ts";
import { assertEquals } from "@std/assert";

const OK_VERSION: VersionStatus = { kind: "ok" };

function input(overrides: Partial<IconInput> = {}): IconInput {
  return {
    unlocked: true,
    versionStatus: OK_VERSION,
    conflictCount: 0,
    state: "disconnected",
    pendingCount: 0,
    dirtyCount: 0,
    lastSyncTime: 0,
    lastAckAt: 0,
    syncingProgress: null,
    reconnectDelay: 0,
    offlineSince: 0,
    lastAttemptAt: 0,
    droppedCount: 0,
    pausedAt: 0,
    massDeleteHold: null,
    now: Date.now(),
    maxRetries: 0,
    ...overrides,
  };
}

Deno.test("statusbar - locked shows lock-keyhole icon", () => {
  const s = resolveIcon(input({ unlocked: false, state: "connecting" }));
  assertEquals(s.icon, "lock-keyhole");
  assertEquals(s.color, "geode-statusbar-locked");
  assertEquals(s.tooltip, "Geode: locked");
});

Deno.test("statusbar - live synced shows circle-check", () => {
  const s = resolveIcon(input({ state: "live", lastSyncTime: Date.now() }));
  assertEquals(s.icon, "circle-check");
  assertEquals(s.color, "geode-statusbar-ok");
  assertEquals(s.tooltip.includes("Geode: synced"), true);
});

Deno.test("statusbar - live with pending shows spinning refresh-cw", () => {
  const s = resolveIcon(input({ state: "live", pendingCount: 3 }));
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.color, "geode-statusbar-ok");
  assertEquals(s.spin, true);
  assertEquals(s.tooltip, "Geode: pushing (3)");
});

Deno.test("statusbar - live with in-flight apply progress shows applying spinner, not synced", () => {
  const s = resolveIcon(
    input({ state: "live", lastSyncTime: Date.now(), syncingProgress: { current: 3, total: 7 } }),
  );
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.color, "geode-statusbar-syncing");
  assertEquals(s.spin, true);
  assertEquals(s.tooltip, "Geode: applying 3/7");
});

Deno.test("statusbar - live with completed apply progress (current === total) shows synced", () => {
  const s = resolveIcon(
    input({ state: "live", lastSyncTime: Date.now(), syncingProgress: { current: 7, total: 7 } }),
  );
  assertEquals(s.icon, "circle-check");
});

Deno.test("statusbar - syncing shows spinning refresh-cw with muted color", () => {
  const s = resolveIcon(input({ state: "syncing" }));
  assertEquals(s.color, "geode-statusbar-syncing");
  assertEquals(s.spin, true);
});

Deno.test("statusbar - disconnected shows refresh-cw-off with error color", () => {
  const s = resolveIcon(input({ state: "disconnected", reconnectDelay: 15000 }));
  assertEquals(s.icon, "refresh-cw-off");
  assertEquals(s.color, "geode-statusbar-error");
  assertEquals(s.spin, undefined);
  assertEquals(s.tooltip.includes("Geode: offline"), true);
});

Deno.test("statusbar - conflicts override with git-merge in orange, not the red error state", () => {
  const s = resolveIcon(input({ state: "live", lastSyncTime: Date.now(), conflictCount: 2 }));
  assertEquals(s.icon, "git-merge");
  assertEquals(s.color, "geode-statusbar-conflict");
  assertEquals(s.tooltip, "Geode: 2 conflicts");
});

const MIN = 60_000;
const HOUR = 3_600_000;

Deno.test("statusbar - paused shows pause-circle with age colour and no-dash tooltip", () => {
  const s = resolveIcon(input({ pausedAt: Date.now() - 2 * MIN }));
  assertEquals(s.icon, "pause-circle");
  assertEquals(s.color, "geode-statusbar-paused-grey");
  assertEquals(s.tooltip, "Sync paused. Paused 2 min ago.");
  assertEquals(s.tooltip.includes("-"), false);
});

Deno.test("statusbar - paused orange after 10 min, red after 30", () => {
  assertEquals(
    resolveIcon(input({ pausedAt: Date.now() - 15 * MIN })).color,
    "geode-statusbar-paused-orange",
  );
  assertEquals(
    resolveIcon(input({ pausedAt: Date.now() - 2 * HOUR })).color,
    "geode-statusbar-paused-red",
  );
});

Deno.test("statusbar - paused beats conflicts and version block", () => {
  assertEquals(
    resolveIcon(input({ pausedAt: Date.now() - 2 * MIN, conflictCount: 3 })).icon,
    "pause-circle",
  );
  assertEquals(
    resolveIcon(input({
      pausedAt: Date.now() - 2 * MIN,
      versionStatus: { kind: "blocked", side: "plugin" },
    })).icon,
    "pause-circle",
  );
});

Deno.test("statusbar - locked still beats paused", () => {
  assertEquals(
    resolveIcon(input({ pausedAt: Date.now() - 2 * MIN, unlocked: false })).icon,
    "lock-keyhole",
  );
});

Deno.test("statusbar - connecting shows spinning refresh-cw", () => {
  const s = resolveIcon(input({ state: "connecting" }));
  assertEquals(s.color, "geode-statusbar-syncing");
  assertEquals(s.spin, true);
  assertEquals(s.tooltip, "Geode: connecting...");
});

// #420: spin from the first save until the server acks; the ack's green check holds ≥1 s; orange after 3 failed tries.
const T0 = 1_000_000;

Deno.test("statusbar - no green between flush and ack: pending with a stale ack spins", () => {
  const s = resolveIcon(input({ state: "live", pendingCount: 1, lastAckAt: T0 - 5_000, now: T0 }));
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.spin, true);
});

Deno.test("statusbar - dirty (debounce window) spins from the first save", () => {
  const s = resolveIcon(input({ state: "live", dirtyCount: 1, now: T0 }));
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.spin, true);
});

Deno.test("statusbar - a recent connect/drain stamp does not start the green hold", () => {
  // lastSync is fresh (just connected / drained) but no outbound ack: the
  // first save must spin, not hold green (#420 decision 1).
  const s = resolveIcon(input({ state: "live", dirtyCount: 1, lastSyncTime: T0 - 300, now: T0 }));
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.spin, true);
});

Deno.test("statusbar - green held ≥1 s after ack even with a new save", () => {
  assertEquals(
    resolveIcon(input({ state: "live", pendingCount: 1, lastAckAt: T0 - 500, now: T0 })).icon,
    "circle-check",
  );
  assertEquals(
    resolveIcon(input({ state: "live", dirtyCount: 1, lastAckAt: T0 - 999, now: T0 })).icon,
    "circle-check",
  );
});

Deno.test("statusbar - green hold expires after 1 s and spinning resumes", () => {
  const s = resolveIcon(input({ state: "live", pendingCount: 1, lastAckAt: T0 - 1_001, now: T0 }));
  assertEquals(s.icon, "refresh-cw");
  assertEquals(s.spin, true);
});

Deno.test("statusbar - no green hold without an ack", () => {
  const s = resolveIcon(input({ state: "live", dirtyCount: 1, lastAckAt: 0, now: T0 }));
  assertEquals(s.icon, "refresh-cw");
});

Deno.test("statusbar - orange after the 3rd failed commit try, spinning before", () => {
  const s2 = resolveIcon(input({ state: "live", pendingCount: 1, maxRetries: 2, now: T0 }));
  assertEquals(s2.icon, "refresh-cw");
  assertEquals(s2.color, "geode-statusbar-ok");
  const s3 = resolveIcon(input({ state: "live", pendingCount: 1, maxRetries: 3, now: T0 }));
  assertEquals(s3.icon, "refresh-cw");
  assertEquals(s3.color, "geode-statusbar-dirty");
  assertEquals(s3.spin, true);
  assertEquals(s3.tooltip, "Geode: upload failing (retry 3)");
});

Deno.test("statusbar - applying backlog beats orange and green hold", () => {
  const s = resolveIcon(
    input({
      state: "live",
      syncingProgress: { current: 3, total: 7 },
      maxRetries: 3,
      lastAckAt: T0 - 100,
      now: T0,
    }),
  );
  assertEquals(s.tooltip, "Geode: applying 3/7");
});

// #523: no green check between the applying events of a catch-up batch: the
// icon only turns green once current === total (the drain is done).
Deno.test("statusbar - no green between applying events of a catch-up batch", () => {
  for (let i = 1; i < 5; i++) {
    const s = resolveIcon(
      input({ state: "live", syncingProgress: { current: i, total: 5 }, now: T0 }),
    );
    assertEquals(s.icon, `refresh-cw`, `applying ${i}/5 must keep spinning`);
    assertEquals(s.spin, true);
  }
  assertEquals(
    resolveIcon(input({ state: "live", syncingProgress: { current: 5, total: 5 }, now: T0 })).icon,
    "circle-check",
  );
});

Deno.test("statusbar - a held mass delete is its own orange warning, not the connecting spinner", () => {
  const hold = {
    files: [{ path: "a.md", mtime: 1 }, { path: "b.md", mtime: 2 }],
    totalTracked: 10,
    detectedAt: 5,
  };
  const s = resolveIcon(input({ state: "disconnected", massDeleteHold: hold }));
  assertEquals(s.icon, "file-warning");
  assertEquals(s.color, "geode-statusbar-hold");
  assertEquals(s.spin, undefined);
  assertEquals(s.tooltip, "2 files missing. Sync is on hold.");
  // Outranks version and conflicts (it is the only state that needs a decision), but a
  // user pause still outranks it.
  assertEquals(resolveIcon(input({ massDeleteHold: hold, conflictCount: 3 })).icon, "file-warning");
  assertEquals(
    resolveIcon(input({ massDeleteHold: hold, pausedAt: Date.now() })).icon,
    "pause-circle",
  );
});

Deno.test("statusbar - a version refusal outranks a hold (nothing can sync until it updates)", () => {
  const hold = { files: [{ path: "a.md", mtime: 1 }], totalTracked: 10, detectedAt: 5 };
  const s = resolveIcon(input({
    massDeleteHold: hold,
    versionStatus: { kind: "blocked", side: "plugin" },
  }));
  assertEquals(s.icon, "triangle-alert");
  assertEquals(s.color, "geode-statusbar-error");
  assertEquals(s.tooltip, "Geode: update the plugin to keep syncing");
});

Deno.test("statusbar - a decided hold (null) falls back to the normal state", () => {
  const s = resolveIcon(input({ state: "live", massDeleteHold: null }));
  assertEquals(s.icon, "circle-check");
});
