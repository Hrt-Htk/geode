import { assert, assertEquals } from "@std/assert";
import {
  freshResult,
  GEODE_RELEASES_URL,
  INITIAL_FAILURE_STATE,
  NO_RESULT_MS,
  noteJobStatus,
  noteUpdateFailure,
  noteUpdateSuccess,
  noticeDue,
  notRun,
  PLUGIN_VERSION_ROW_NAME,
  RUN_LIMIT_MS,
  SERVER_UPDATE_COMMAND,
  serverUpdateRow,
  UPDATE_CONFIRM_LINES,
  UPDATE_ROW_NAME,
  updateExpired,
  updateOutcome,
} from "../../../plugin/ui/server-update-logic.ts";

// #44/#51: the plugin's server update, as pure decisions: the Server version row copy and control,
// the job's result words as one line, failure persistence, the stale-result rule, the polling
// deadlines, and whether the one time notice is due. The obsidian files render these.

const OWN = "1.0.2";
const row = (
  i: {
    server: string;
    refused?: boolean;
    updating?: boolean;
    lastUpdateFailed?: boolean;
  },
) =>
  serverUpdateRow({
    own: OWN,
    refused: false,
    updating: false,
    lastUpdateFailed: false,
    ...i,
  });

Deno.test("server update - row names and releases link match #51", () => {
  assertEquals(UPDATE_ROW_NAME, "Server version");
  assertEquals(PLUGIN_VERSION_ROW_NAME, "Plugin version");
  assertEquals(GEODE_RELEASES_URL, "https://github.com/Hrt-Htk/geode/releases");
});

Deno.test("server update - confirm copy covers this device and names no target version", () => {
  assert(
    UPDATE_CONFIRM_LINES.some((l) => l.includes("This device")),
    "confirm copy must cover this device too",
  );
  for (const line of UPDATE_CONFIRM_LINES) {
    assert(!/\d+\.\d+\.\d+/.test(line), `no version number in confirm: ${line}`);
  }
});

Deno.test("server update - every result word the job writes maps to its line", () => {
  const text = (word: string) => updateOutcome(word, "1.0.1");
  assertEquals(text("updated"), { text: "Server updated to 1.0.1.", showCommand: false });
  assertEquals(text("up-to-date"), { text: "Server is already up to date.", showCommand: false });
  assertEquals(text("rate-limited"), {
    text: "An update ran recently. Try again in a few minutes.",
    showCommand: false,
  });
  for (const word of ["rolled-back", "blocked", "pull-failed"]) {
    assertEquals(text(word), {
      text: "The update failed. The server is back on 1.0.1.",
      showCommand: true,
    });
  }
  for (const word of ["rollback-failed", "config-failed", "no-flock"]) {
    assertEquals(text(word), notRun(), `${word} did not run`);
  }
  assertEquals(text("something-new"), {
    text: "The update failed. The server is back on 1.0.1.",
    showCommand: true,
  });
});

Deno.test("server update - failure epoch tracking keeps failed status across stale prior success", () => {
  // Run 1 succeeds with server result epoch 1005.
  let state = noteUpdateSuccess(INITIAL_FAILURE_STATE, 1005);
  state = noteJobStatus(state, { word: "up-to-date", epoch: 1005 });
  assertEquals(state.failed, false);

  // Run 2 POST fails before a requestEpoch is issued (requestEpoch reset to 0).
  state = noteUpdateFailure(state, 0);
  assertEquals(state.failed, true);

  // refreshJob() reads Run 1's up-to-date result (epoch 1005 <= failedEpoch 1005): failure stays.
  state = noteJobStatus(state, { word: "up-to-date", epoch: 1005 });
  assertEquals(state.failed, true);

  // A running or rate-limited result does not flip failure either way.
  state = noteJobStatus(state, { word: "running", epoch: 1006 });
  assertEquals(state.failed, true);
  state = noteJobStatus(state, { word: "rate-limited", epoch: 1007 });
  assertEquals(state.failed, true);

  // A strictly newer success clears the failure.
  state = noteJobStatus(state, { word: "updated", epoch: 1010 });
  assertEquals(state.failed, false);

  // A newer failed job result from /update/status sets failed, while running/rate-limited do not.
  assertEquals(noteJobStatus(state, { word: "running", epoch: 1011 }).failed, false);
  assertEquals(noteJobStatus(state, { word: "rate-limited", epoch: 1011 }).failed, false);
  assertEquals(noteJobStatus(state, { word: "rolled-back", epoch: 1012 }).failed, true);
});

Deno.test("server update - notRun shows the update command", () => {
  assertEquals(notRun(), {
    text: "The update did not run. Copy the command below.",
    showCommand: true,
  });
  assert(SERVER_UPDATE_COMMAND.includes("docker compose pull"));
});

Deno.test("server update - up to date when server matches or exceeds plugin", () => {
  assertEquals(row({ server: OWN }), { kind: "plain", desc: `${OWN}. Up to date.` });
  assertEquals(row({ server: "1.0.3" }), { kind: "plain", desc: "1.0.3. Up to date." });
});

Deno.test("server update - older server always offers one Update", () => {
  assertEquals(row({ server: "1.0.1" }), {
    kind: "action",
    desc: "1.0.1. Update available.",
    control: "update",
  });
});

Deno.test("server update - a run in flight disables the row's Update", () => {
  assertEquals(row({ server: "1.0.1", updating: true }), {
    kind: "action",
    desc: "1.0.1. Updating.",
    control: "updating",
  });
});

Deno.test("server update - last failed update stays visible until a later one works", () => {
  assertEquals(row({ server: "1.0.1", lastUpdateFailed: true }), {
    kind: "action",
    desc: "1.0.1. Last update failed.",
    control: "update",
  });
  assertEquals(row({ server: "1.0.1", refused: true, lastUpdateFailed: true }), {
    kind: "plain",
    desc: "1.0.1. Last update failed.",
  });
  // Once the server is up to date, the older failure clears.
  assertEquals(row({ server: OWN, lastUpdateFailed: true }), {
    kind: "plain",
    desc: `${OWN}. Up to date.`,
  });
});

Deno.test("server update - a refused server names the stop and drops the row button", () => {
  assertEquals(row({ server: "1.0.1", refused: true }), {
    kind: "plain",
    desc: "1.0.1. Too old for this plugin.",
  });
});

Deno.test("server update - only a result at or after the request counts", () => {
  const status = (word: string, epoch: number) => ({ installed: true, result: { word, epoch } });
  assertEquals(freshResult(null, 100), null);
  assertEquals(freshResult({ installed: false, result: null }, 100), null);
  assertEquals(freshResult(status("updated", 99), 100), null, "the previous run's result");
  assertEquals(freshResult(status("running", 100), 100), { word: "running", epoch: 100 });
  assertEquals(freshResult(status("updated", 101), 100), { word: "updated", epoch: 101 });
});

Deno.test("server update - no result within 150 s, or a run past 12 minutes, ends the wait", () => {
  assertEquals(updateExpired({ sincePostMs: 0, sinceResultMs: 0 }), false);
  assertEquals(
    updateExpired({ sincePostMs: NO_RESULT_MS - 1, sinceResultMs: NO_RESULT_MS - 1 }),
    false,
  );
  assertEquals(updateExpired({ sincePostMs: 60_000, sinceResultMs: NO_RESULT_MS }), true);
  assertEquals(updateExpired({ sincePostMs: RUN_LIMIT_MS - 1, sinceResultMs: 1_000 }), false);
  assertEquals(updateExpired({ sincePostMs: RUN_LIMIT_MS, sinceResultMs: 1_000 }), true);
});

Deno.test("server update - the notice is once per plugin version, and only for an older server", () => {
  assertEquals(noticeDue({ own: OWN, server: null, seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: "1.0.3", seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: OWN, seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: "1.0.1", seenVersion: "" }), true);
  assertEquals(noticeDue({ own: OWN, server: "1.0.1", seenVersion: "1.0.1" }), true);
  assertEquals(noticeDue({ own: OWN, server: "1.0.1", seenVersion: OWN }), false);
});

Deno.test("server update - beta versions follow semver precedence", () => {
  assertEquals(
    serverUpdateRow({
      own: "1.0.2-beta.2",
      server: "1.0.2-beta.1",
      refused: false,
      updating: false,
      lastUpdateFailed: false,
    }),
    { kind: "action", desc: "1.0.2-beta.1. Update available.", control: "update" },
  );
  assertEquals(
    serverUpdateRow({
      own: "1.0.2-beta.1",
      server: "1.0.2",
      refused: false,
      updating: false,
      lastUpdateFailed: false,
    }),
    { kind: "plain", desc: "1.0.2. Up to date." },
  );
  assertEquals(noticeDue({ own: "1.0.2", server: "1.0.2-beta.1", seenVersion: "" }), true);
  assertEquals(noticeDue({ own: "1.0.2-beta.1", server: "1.0.2", seenVersion: "" }), false);
});
