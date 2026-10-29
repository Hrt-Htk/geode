// #601: resuming the user pause while a mass delete is held must lift the manager's pause
// (otherwise the decision stays refused with "Resume sync first" forever) without opening the
// transport: the unconfirmed deletes would sync.

import { assertEquals } from "@std/assert";
import { resumeSessionSync, type SyncSessionHost } from "../../../plugin/session.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

function host(calls: string[], held: boolean): SyncSessionHost {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      serverUrl: "http://127.0.0.1:1",
      vaultId: "v",
      deviceId: "d",
      deviceToken: "t",
      massDeleteHold: held
        ? { files: [{ path: "a.md", mtime: 1 }], totalTracked: 1, detectedAt: 1 }
        : null,
    },
    syncManager: {
      resume: () => calls.push("resume"),
    },
    transport: {
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      isLive: () => false,
    },
    state: { getSyncCursor: () => 0 },
    manifest: { version: "0.0.0" },
    statusBar: { clearOffline: () => calls.push("clearOffline") },
  } as unknown as SyncSessionHost;
}

Deno.test("session resume - a held mass delete lifts the pause but never connects", () => {
  const calls: string[] = [];
  resumeSessionSync(host(calls, true));
  assertEquals(
    calls,
    ["resume"],
    "the manager pause is lifted; the hold is no reason to stay paused",
  );
});

Deno.test("session resume - no hold resumes and reconnects", () => {
  const calls: string[] = [];
  resumeSessionSync(host(calls, false));
  assertEquals(calls, ["resume", "clearOffline", "start"]);
});
