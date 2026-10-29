import { describeSyncStatus, type SyncStatusInput } from "../../../plugin/ui/sync-status.ts";
import { assertEquals } from "@std/assert";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function input(over: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    unlocked: true,
    versionStatus: { kind: "ok" },
    conflictCount: 0,
    state: "live",
    pendingCount: 0,
    dirtyCount: 0,
    lastSyncTime: 0,
    lastAckAt: 0,
    syncingProgress: null,
    reconnectDelay: 0,
    offlineSince: 0,
    lastAttemptAt: 0,
    droppedCount: 0,
    lastBackupAt: 0,
    pausedAt: 0,
    massDeleteHold: null,
    now: 0,
    maxRetries: 0,
    ...over,
  };
}

const blocked = { kind: "blocked" as const, side: "plugin" as const };
const blockedServerBehind = { kind: "blocked" as const, side: "server" as const };
const hintNewer = { kind: "hint" as const, own: "1.0.0", server: "2.0.0" };
const hintOlder = { kind: "hint" as const, own: "2.0.0", server: "1.0.0" };

Deno.test("sync-status - locked", () => {
  assertEquals(describeSyncStatus(input({ unlocked: false }), 0), {
    text: "Locked. Nothing syncs until you unlock. Not backed up yet.",
    dot: "grey",
  });
  const now = 1_000;
  assertEquals(describeSyncStatus(input({ unlocked: false, lastBackupAt: now - 2 * MIN }), now), {
    text: "Locked. Nothing syncs until you unlock. Last backup 2 min ago.",
    dot: "grey",
  });
});

Deno.test("sync-status - version blocked names the side that must update", () => {
  assertEquals(describeSyncStatus(input({ versionStatus: blocked, lastBackupAt: 0 }), 0), {
    text: "Update the plugin to keep syncing. Not backed up yet.",
    dot: "red",
  });
  assertEquals(
    describeSyncStatus(input({ versionStatus: blockedServerBehind, lastBackupAt: 0 }), 0),
    {
      text: "Update the Geode server to keep syncing. Not backed up yet.",
      dot: "red",
    },
  );
});

Deno.test("sync-status - compatible difference: server newer → plugin update hint (#529)", () => {
  assertEquals(describeSyncStatus(input({ versionStatus: hintNewer }), 0), {
    text: "Plugin update available",
    dot: "orange",
  });
});

Deno.test("sync-status - compatible difference: server older → server update hint (#529)", () => {
  assertEquals(describeSyncStatus(input({ versionStatus: hintOlder }), 0), {
    text: "Server update available",
    dot: "orange",
  });
});

Deno.test("sync-status - hint yields to pending uploads and offline (#529)", () => {
  assertEquals(
    describeSyncStatus(input({ versionStatus: hintNewer, pendingCount: 2 }), 0),
    { text: "Uploading 2 changes. Not backed up yet.", dot: "blue" },
  );
  assertEquals(
    describeSyncStatus(
      input({ versionStatus: hintNewer, state: "disconnected", reconnectDelay: 4_500 }),
      0,
    ),
    { text: "Offline. Retrying in 5 s. Not backed up yet.", dot: "orange" },
  );
});

Deno.test("sync-status - conflicts singular and plural", () => {
  assertEquals(describeSyncStatus(input({ conflictCount: 1 }), 0), {
    text: "1 conflict to review. Not backed up yet.",
    dot: "orange",
  });
  assertEquals(describeSyncStatus(input({ conflictCount: 3 }), 0), {
    text: "3 conflicts to review. Not backed up yet.",
    dot: "orange",
  });
});

Deno.test("sync-status - catching up with progress (live and syncing)", () => {
  const progress = { current: 3, total: 10 };
  assertEquals(describeSyncStatus(input({ state: "live", syncingProgress: progress }), 0), {
    text: "Catching up: 3 of 10 changes. Not backed up yet.",
    dot: "blue",
  });
  assertEquals(describeSyncStatus(input({ state: "syncing", syncingProgress: progress }), 0), {
    text: "Catching up: 3 of 10 changes. Not backed up yet.",
    dot: "blue",
  });
});

Deno.test("sync-status - uploading singular and plural", () => {
  assertEquals(describeSyncStatus(input({ pendingCount: 1 }), 0), {
    text: "Uploading 1 change. Not backed up yet.",
    dot: "blue",
  });
  assertEquals(describeSyncStatus(input({ pendingCount: 2, dirtyCount: 1 }), 0), {
    text: "Uploading 3 changes. Not backed up yet.",
    dot: "blue",
  });
});

Deno.test("sync-status - up to date with backup suffix", () => {
  const now = 1_000;
  assertEquals(describeSyncStatus(input({ lastBackupAt: now - 12 * MIN }), now), {
    text: "Up to date. Last backup 12 min ago.",
    dot: "green",
  });
});

Deno.test("sync-status - up to date never backed up", () => {
  assertEquals(describeSyncStatus(input(), 0), { text: "Not backed up yet.", dot: null });
});

Deno.test("sync-status - syncing without progress", () => {
  assertEquals(describeSyncStatus(input({ state: "syncing" }), 0), {
    text: "Catching up… Not backed up yet.",
    dot: "blue",
  });
});

Deno.test("sync-status - disconnected", () => {
  assertEquals(describeSyncStatus(input({ state: "disconnected", reconnectDelay: 4_500 }), 0), {
    text: "Offline. Retrying in 5 s. Not backed up yet.",
    dot: "orange",
  });
});

Deno.test("sync-status - other state connecting, no suffix", () => {
  assertEquals(describeSyncStatus(input({ state: "connecting" }), 0), {
    text: "Connecting…",
    dot: "grey",
  });
});

Deno.test("sync-status - precedence: locked > blocked > conflicts > transport", () => {
  const now = 1_000;
  const everything = input({
    unlocked: false,
    versionStatus: blocked,
    conflictCount: 2,
    state: "disconnected",
    reconnectDelay: 5_000,
    lastBackupAt: now - 12 * MIN,
  });
  assertEquals(
    describeSyncStatus(everything, now).text,
    "Locked. Nothing syncs until you unlock. Last backup 12 min ago.",
  );

  assertEquals(
    describeSyncStatus(
      input({
        versionStatus: blocked,
        conflictCount: 2,
        state: "disconnected",
        reconnectDelay: 5_000,
        lastBackupAt: now - 12 * MIN,
      }),
      now,
    ).text,
    "Update the plugin to keep syncing. Last backup 12 min ago.",
  );

  assertEquals(
    describeSyncStatus(
      input({
        conflictCount: 2,
        state: "disconnected",
        reconnectDelay: 5_000,
        lastBackupAt: now - 12 * MIN,
      }),
      now,
    ).text,
    "2 conflicts to review. Last backup 12 min ago.",
  );
});

Deno.test("sync-status - backup age buckets", () => {
  const now = 1_000;
  const age = (ms: number) => describeSyncStatus(input({ lastBackupAt: now - ms }), now).text;

  assertEquals(age(0), "Up to date. Last backup just now.");
  assertEquals(age(59_000), "Up to date. Last backup just now.");
  assertEquals(age(60_000), "Up to date. Last backup 1 min ago.");
  assertEquals(age(11 * MIN + 59_000), "Up to date. Last backup 11 min ago.");
  assertEquals(age(HOUR), "Up to date. Last backup 1 h ago.");
  assertEquals(age(23 * HOUR + 59 * MIN), "Up to date. Last backup 23 h ago.");
  assertEquals(age(DAY), "Up to date. Last backup 1 d ago.");
  assertEquals(age(2 * DAY + 11 * HOUR), "Up to date. Last backup 2 d ago.");
});

Deno.test("sync-status - paused shows pause copy, dot follows age", () => {
  const now = 1_700_000_000_000;
  const r = describeSyncStatus(input({ pausedAt: now - 5 * MIN }), now);
  assertEquals(r.text, "Paused. Changes are kept locally and upload when you resume.");
  assertEquals(r.dot, "grey");
  assertEquals(r.conflictText, undefined);
});

Deno.test("sync-status - paused with pending changes counts dirty + pending", () => {
  const now = 1_700_000_000_000;
  const r = describeSyncStatus(
    input({ pausedAt: now - 5 * MIN, pendingCount: 2, dirtyCount: 1 }),
    now,
  );
  assertEquals(
    r.text,
    "Paused. Changes are kept locally and upload when you resume. 3 changes waiting.",
  );
});

Deno.test("sync-status - paused orange and red dots", () => {
  const now = 1_700_000_000_000;
  assertEquals(describeSyncStatus(input({ pausedAt: now - 15 * MIN }), now).dot, "orange");
  assertEquals(describeSyncStatus(input({ pausedAt: now - 2 * HOUR }), now).dot, "red");
});

Deno.test("sync-status - paused with conflicts keeps conflicts on their own line", () => {
  const now = 1_700_000_000_000;
  const r = describeSyncStatus(
    input({ pausedAt: now - 5 * MIN, conflictCount: 2, pendingCount: 1 }),
    now,
  );
  assertEquals(
    r.text,
    "Paused. Changes are kept locally and upload when you resume. 1 change waiting.",
  );
  assertEquals(r.conflictText, "2 conflicts to review.");
  assertEquals(
    describeSyncStatus(input({ pausedAt: now - 5 * MIN, conflictCount: 1 }), now).conflictText,
    "1 conflict to review.",
  );
});

Deno.test("sync-status - paused beats conflicts, offline and blocked", () => {
  const now = 1_700_000_000_000;
  const r = describeSyncStatus(
    input({
      pausedAt: now - 5 * MIN,
      conflictCount: 2,
      state: "disconnected",
      reconnectDelay: 5_000,
      versionStatus: blocked,
    }),
    now,
  );
  assertEquals(r.text, "Paused. Changes are kept locally and upload when you resume.");
  assertEquals(r.dot, "grey");
});

Deno.test("sync-status - locked still beats paused", () => {
  const now = 1_700_000_000_000;
  const r = describeSyncStatus(input({ pausedAt: now - 5 * MIN, unlocked: false }), now);
  assertEquals(r.text, "Locked. Nothing syncs until you unlock. Not backed up yet.");
  assertEquals(r.dot, "grey");
});

Deno.test("sync-status - dropped uploads replace up to date", () => {
  const now = 10 * MIN;
  assertEquals(describeSyncStatus(input({ droppedCount: 2, lastBackupAt: now - 3 * MIN }), now), {
    text: "2 changes couldn't upload. Last backup 3 min ago.",
    dot: "orange",
  });
  assertEquals(describeSyncStatus(input({ droppedCount: 1 }), now), {
    text: "1 change couldn't upload. Not backed up yet.",
    dot: "orange",
  });
  assertEquals(
    describeSyncStatus(input({ droppedCount: 1, pendingCount: 2 }), now).text,
    "Uploading 2 changes. Not backed up yet.",
  );
});

Deno.test("sync-status - a version refusal outranks a held mass delete", () => {
  const hold = { files: [{ path: "a.md", mtime: 1 }], totalTracked: 10, detectedAt: 5 };
  assertEquals(
    describeSyncStatus(
      input({ massDeleteHold: hold, versionStatus: blocked, lastBackupAt: 0 }),
      0,
    ),
    { text: "Update the plugin to keep syncing. Not backed up yet.", dot: "red" },
  );
});

Deno.test("sync-status - a held mass delete names the hold, not the server", () => {
  const hold = {
    files: [{ path: "a.md", mtime: 1 }],
    totalTracked: 10,
    detectedAt: 5,
  };
  assertEquals(describeSyncStatus(input({ massDeleteHold: hold, state: "disconnected" }), 0), {
    text: "1 file missing. Sync is on hold.",
    dot: "orange",
  });
});
