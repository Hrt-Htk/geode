import { assert, assertEquals } from "@std/assert";
import {
  freshResult,
  NO_RESULT_MS,
  noticeDue,
  notRun,
  RUN_LIMIT_MS,
  SERVER_UPDATE_COMMAND,
  serverUpdateRow,
  updateExpired,
  updateOutcome,
} from "../../../plugin/ui/server-update-logic.ts";

// #44: the plugin's server update, as pure decisions: the row's copy and its control, the
// job's result words as one line, the stale-result rule, the polling deadlines, and whether
// the one time notice is due. The obsidian files render these.

const OWN = "0.45.0";

Deno.test("server update - every result word the job writes maps to its line", () => {
  const text = (word: string) => updateOutcome(word, "0.44.0");
  assertEquals(text("updated"), {
    kind: "updated",
    text: "Server updated to 0.44.0.",
    showCommand: false,
  });
  assertEquals(text("up-to-date"), {
    kind: "up-to-date",
    text: "Server is already up to date.",
    showCommand: false,
  });
  assertEquals(text("rate-limited"), {
    kind: "rate-limited",
    text: "An update ran recently. Try again in a few minutes.",
    showCommand: false,
  });
  for (const word of ["rolled-back", "blocked", "pull-failed"]) {
    assertEquals(text(word), {
      kind: "failed",
      text: "The update failed. The server is back on 0.44.0.",
      showCommand: true,
    });
  }
  for (const word of ["rollback-failed", "config-failed", "no-flock"]) {
    assertEquals(text(word), notRun(), `${word} did not run`);
  }
  // A word a newer job adds is still a run that ended without success, not a run that never
  // happened: the version /version answers is the one it is on.
  assertEquals(text("something-new"), {
    kind: "failed",
    text: "The update failed. The server is back on 0.44.0.",
    showCommand: true,
  });
});

Deno.test("server update - a run that did not happen shows the command", () => {
  assertEquals(notRun(), {
    kind: "not-run",
    text: "The update did not run. Copy the command below.",
    showCommand: true,
  });
  assert(SERVER_UPDATE_COMMAND.includes("docker compose pull"));
});

Deno.test("server update - the row shows the server version when nothing is to be done", () => {
  const base = { own: OWN, refused: false, jobInstalled: true, updating: false };
  assertEquals(serverUpdateRow({ ...base, server: null }), { kind: "none" });
  assertEquals(serverUpdateRow({ ...base, server: OWN }), {
    kind: "plain",
    desc: `Server ${OWN}.`,
  });
  // The plugin is the side to update: the row names no action.
  assertEquals(serverUpdateRow({ ...base, server: "0.46.0" }), {
    kind: "plain",
    desc: "Server 0.46.0.",
  });
});

Deno.test("server update - an older server with the job installed offers Update", () => {
  assertEquals(
    serverUpdateRow({
      own: OWN,
      server: "0.44.0",
      refused: false,
      jobInstalled: true,
      updating: false,
    }),
    { kind: "action", desc: "Server 0.44.0, plugin 0.45.0.", control: "update" },
  );
});

Deno.test("server update - no job, or no answer yet, keeps the row usable", () => {
  assertEquals(
    serverUpdateRow({
      own: OWN,
      server: "0.44.0",
      refused: false,
      jobInstalled: false,
      updating: false,
    }),
    {
      kind: "action",
      desc: "The update job is not installed. Run the command on the server.",
      control: "copy",
    },
  );
  // Unknown is the update path: the POST is what finds out.
  assertEquals(
    serverUpdateRow({
      own: OWN,
      server: "0.44.0",
      refused: false,
      jobInstalled: null,
      updating: false,
    }),
    { kind: "action", desc: "Server 0.44.0, plugin 0.45.0.", control: "update" },
  );
});

Deno.test("server update - a run in flight disables the row's Update", () => {
  assertEquals(
    serverUpdateRow({
      own: OWN,
      server: "0.44.0",
      refused: false,
      jobInstalled: true,
      updating: true,
    }),
    { kind: "action", desc: "Server 0.44.0, plugin 0.45.0.", control: "updating" },
  );
});

Deno.test("server update - a refused server keeps the row to the versions", () => {
  assertEquals(
    serverUpdateRow({
      own: OWN,
      server: "0.44.0",
      refused: true,
      jobInstalled: true,
      updating: false,
    }),
    { kind: "plain", desc: "Server 0.44.0, plugin 0.45.0." },
  );
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
  // A fresh `running` keeps the short deadline away; the long one still applies.
  assertEquals(updateExpired({ sincePostMs: RUN_LIMIT_MS - 1, sinceResultMs: 1_000 }), false);
  assertEquals(updateExpired({ sincePostMs: RUN_LIMIT_MS, sinceResultMs: 1_000 }), true);
});

Deno.test("server update - the notice is once per plugin version, and only for an older server", () => {
  assertEquals(noticeDue({ own: OWN, server: null, seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: "0.46.0", seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: OWN, seenVersion: "" }), false);
  assertEquals(noticeDue({ own: OWN, server: "0.44.0", seenVersion: "" }), true);
  assertEquals(noticeDue({ own: OWN, server: "0.44.0", seenVersion: "0.44.0" }), true);
  assertEquals(noticeDue({ own: OWN, server: "0.44.0", seenVersion: OWN }), false);
});
