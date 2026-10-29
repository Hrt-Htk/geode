import { assert, assertEquals } from "@std/assert";
import { describeErrorBanner, nextOfflineSince } from "../../../plugin/ui/sync-banner.ts";
import type { SyncStatusInput } from "../../../plugin/ui/sync-status.ts";

const NOW = 1_700_000_000_000;
// The e2e fixtures and stored settings may carry a scheme (server.url) or be
// schemeless (legacy / setup-wizard saves); the banner must name the host in
// both forms.
const SERVER_URL = "http://127.0.0.1:8099";

function input(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    unlocked: true,
    versionStatus: { kind: "ok" },
    conflictCount: 0,
    state: "live",
    pendingCount: 0,
    dirtyCount: 0,
    lastSyncTime: 0,
    syncingProgress: null,
    reconnectDelay: 0,
    offlineSince: 0,
    lastAttemptAt: 0,
    droppedCount: 0,
    lastBackupAt: 0,
    pausedAt: 0,
    massDeleteHold: null,
    ...overrides,
  };
}

Deno.test("sync-banner - locked shows no banner", () => {
  assertEquals(describeErrorBanner(input({ unlocked: false }), NOW, SERVER_URL), null);
});

Deno.test("sync-banner - version blocked shows no banner (version banner owns it)", () => {
  assertEquals(
    describeErrorBanner(
      input({ versionStatus: { kind: "blocked", side: "plugin" } }),
      NOW,
      SERVER_URL,
    ),
    null,
  );
});

Deno.test("sync-banner - version hint does not hide the unreachable banner (#529)", () => {
  const banner = describeErrorBanner(
    input({
      versionStatus: { kind: "hint", own: "1.0.0", server: "2.0.0" },
      offlineSince: NOW - 60_000,
    }),
    NOW,
    SERVER_URL,
  );
  assert(banner !== null);
  assertEquals(banner.name, "Cannot reach your Geode server");
});

Deno.test("sync-banner - paused hides the unreachable banner", () => {
  assertEquals(
    describeErrorBanner(input({ pausedAt: NOW - 60_000, offlineSince: NOW - 60_000 }), NOW),
    null,
  );
});

Deno.test("sync-banner - healthy shows no banner", () => {
  assertEquals(describeErrorBanner(input({ offlineSince: NOW - 5_000 }), NOW, SERVER_URL), null);
});

Deno.test("sync-banner - disconnected under 10 s shows no banner", () => {
  assertEquals(describeErrorBanner(input({ offlineSince: NOW - 9_999 }), NOW, SERVER_URL), null);
});

Deno.test("sync-banner - disconnected 10 s shows the unreachable banner naming the server", () => {
  const b = describeErrorBanner(input({ offlineSince: NOW - 10_000 }), NOW, SERVER_URL);
  assertEquals(b?.name, "Cannot reach your Geode server");
  assertEquals(
    b?.desc,
    "Sync is paused until 127.0.0.1:8099 is reachable. Last attempt just now.",
  );
});

Deno.test("sync-banner - schemeless server address still names the host", () => {
  const b = describeErrorBanner(
    input({ offlineSince: NOW - 10_000, lastAttemptAt: NOW - 30_000 }),
    NOW,
    "server.local:8099",
  );
  assertEquals(
    b?.desc,
    "Sync is paused until server.local:8099 is reachable. Last attempt 30 s ago.",
  );
});

Deno.test("sync-banner - unreachable wins over dropped", () => {
  const b = describeErrorBanner(
    input({ offlineSince: NOW - 60_000, lastAttemptAt: NOW - 30_000, droppedCount: 3 }),
    NOW,
    SERVER_URL,
  );
  assertEquals(b?.name, "Cannot reach your Geode server");
});

Deno.test("sync-banner - dropped files show the upload-failed banner", () => {
  const b = describeErrorBanner(input({ droppedCount: 3 }), NOW, SERVER_URL);
  assertEquals(b?.name, "Some changes couldn't upload");
  assertEquals(
    b?.desc,
    "3 files failed to upload. They stay on this device.",
  );
});

Deno.test("sync-banner - one dropped file is singular", () => {
  const b = describeErrorBanner(input({ droppedCount: 1 }), NOW, SERVER_URL);
  assertEquals(
    b?.desc,
    "1 file failed to upload. It stays on this device.",
  );
});

Deno.test("sync-banner - attempt age buckets", () => {
  const age = (lastAttemptAt: number) =>
    describeErrorBanner(input({ offlineSince: NOW - 60_000, lastAttemptAt }), NOW, SERVER_URL)
      ?.desc;

  assertEquals(age(NOW - 2_000)?.includes("Last attempt just now"), true, "< 5 s");
  assertEquals(age(NOW - 4_000)?.includes("Last attempt just now"), true, "4 s");
  assertEquals(age(NOW - 5_000)?.includes("Last attempt 5 s ago"), true, "5 s");
  assertEquals(age(NOW - 30_000)?.includes("Last attempt 30 s ago"), true, "30 s");
  assertEquals(age(NOW - 59_000)?.includes("Last attempt 59 s ago"), true, "59 s");
  assertEquals(age(NOW - 60_000)?.includes("Last attempt 1 min ago"), true, "60 s");
  assertEquals(age(NOW - 5 * 60_000)?.includes("Last attempt 5 min ago"), true, "5 min");
  assertEquals(age(NOW - 59 * 60_000)?.includes("Last attempt 59 min ago"), true, "59 min");
  assertEquals(age(NOW - 60 * 60_000)?.includes("Last attempt 1 h ago"), true, "60 min");
  assertEquals(age(NOW - 3 * 3_600_000)?.includes("Last attempt 3 h ago"), true, "3 h");
});

Deno.test("sync-banner - offline time spans reconnect attempts, clears once connected", () => {
  let since = nextOfflineSince(0, "disconnected", NOW);
  assertEquals(since, NOW);
  since = nextOfflineSince(since, "connecting", NOW + 4_000);
  assertEquals(since, NOW, "a reconnect attempt keeps the outage start");
  since = nextOfflineSince(since, "disconnected", NOW + 8_000);
  assertEquals(since, NOW, "still the first disconnect");
  assertEquals(nextOfflineSince(since, "live", NOW + 12_000), 0);
  assertEquals(nextOfflineSince(0, "connecting", NOW), 0, "a first connect is not an outage");
});

Deno.test("sync-banner - a held mass delete is not an outage", () => {
  const hold = { files: [{ path: "a.md", mtime: 1 }], totalTracked: 10, detectedAt: 5 };
  // A hold stops the transport on purpose; 10 s later that would read as "cannot reach
  // your server" under the Sync on hold row.
  assertEquals(
    describeErrorBanner(
      input({ massDeleteHold: hold, state: "disconnected", offlineSince: NOW - 60_000 }),
      NOW,
      SERVER_URL,
    ),
    null,
  );
});
