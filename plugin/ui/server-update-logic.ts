/** #44: the plugin's server update as decisions: the row's copy and control, the job's result
 * words as one line, the stale-result rule, the polling deadlines, and whether the one time
 * notice is due. No obsidian import (safe for deno unit tests); docs carry the why. */
import { compareSemVer } from "../../core/version.ts";
import type { JobResult, JobStatus } from "../plumbing/update-client.ts";

/** What the no job path copies: the job's own command, run on the server (server.md §11). */
export const SERVER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export const UPDATE_ROW_NAME = "Server update";
export const UPDATE_NOTICE = "Server update available.";
export const UPDATE_BUTTON = "Update";
export const UPDATE_TITLE_ASK = "Update the Geode server?";
/** A question mark over a run that already started reads wrong: the same dialog, declarative. */
export const UPDATE_TITLE_RUN = "Update the Geode server";
export const UPDATE_CONFIRM_LINES = [
  "Every vault on this server updates.",
  "Other devices may need the plugin update before they sync again.",
  "Geode restarts during the update.",
];
export const UPDATE_TOKEN_TITLE = "Admin token required";
export const UPDATE_TOKEN_MESSAGE = "Enter the admin token to update the server.";
export const UPDATE_PROGRESS = "Updating the server. Geode reconnects when it is back.";
export const UPDATE_STATUS_UPDATING = "Updating the server.";
export const UPDATE_COPY = "Copy command";
export const UPDATE_DONE = "Done";
export const UPDATE_NO_JOB = "The update job is not installed. Run the command on the server.";

export type UpdateOutcome = {
  kind: "updated" | "up-to-date" | "rate-limited" | "failed" | "not-run";
  text: string;
  /** A run that failed or did not happen shows the command, so it can be finished by hand. */
  showCommand: boolean;
};

/** A run that never reached a result: the command is the next step. */
export function notRun(): UpdateOutcome {
  return {
    kind: "not-run",
    text: "The update did not run. Copy the command below.",
    showCommand: true,
  };
}

/** One result line per word the job writes (server.md §11); `serverVersion` is what it runs now. */
export function updateOutcome(word: string, serverVersion: string): UpdateOutcome {
  switch (word) {
    case "updated":
      return {
        kind: "updated",
        text: `Server updated to ${serverVersion}.`,
        showCommand: false,
      };
    case "up-to-date":
      return { kind: "up-to-date", text: "Server is already up to date.", showCommand: false };
    case "rate-limited":
      return {
        kind: "rate-limited",
        text: "An update ran recently. Try again in a few minutes.",
        showCommand: false,
      };
    case "rollback-failed":
    case "config-failed":
    case "no-flock":
      return notRun();
    default:
      // rolled-back, blocked, pull-failed, and any word a newer job adds: a run that ended
      // without success, so the version /version answers is the one it is on.
      return {
        kind: "failed",
        text: `The update failed. The server is back on ${serverVersion}.`,
        showCommand: true,
      };
  }
}

export type ServerUpdateInput = {
  own: string;
  /** The server's own version, learned from hello_ack; null until it is known. */
  server: string | null;
  /** The server refused this plugin: the banner carries the action, the row the versions. */
  refused: boolean;
  /** null until the job's heartbeat is read: the update is the path that finds out. */
  jobInstalled: boolean | null;
  updating: boolean;
};

export type ServerUpdateRow =
  | { kind: "none" }
  | { kind: "plain"; desc: string }
  | { kind: "action"; desc: string; control: "update" | "copy" | "updating" };

/** The Status row: the versions, and the one control that fits the job's state. */
export function serverUpdateRow(i: ServerUpdateInput): ServerUpdateRow {
  if (i.server === null) return { kind: "none" };
  // Only an older server is this row's business; the plugin's own update keeps the banner.
  if (compareSemVer(i.server, i.own) >= 0) return { kind: "plain", desc: `Server ${i.server}.` };
  const desc = `Server ${i.server}, plugin ${i.own}.`;
  if (i.refused) return { kind: "plain", desc };
  if (i.updating) return { kind: "action", desc, control: "updating" };
  if (i.jobInstalled === false) return { kind: "action", desc: UPDATE_NO_JOB, control: "copy" };
  return { kind: "action", desc, control: "update" };
}

/** The result that answers this POST: one written at or after it. An older one is the last run. */
export function freshResult(status: JobStatus | null, requestEpoch: number): JobResult | null {
  const result = status?.result ?? null;
  if (result === null || result.epoch < requestEpoch) return null;
  return result;
}

/** No result of any kind this long after the request: the job did not run. */
export const NO_RESULT_MS = 150_000;
/** A host that dies mid run leaves `running` forever, so a run has a hard end. */
export const RUN_LIMIT_MS = 12 * 60_000;

export function updateExpired(i: { sincePostMs: number; sinceResultMs: number }): boolean {
  return i.sinceResultMs >= NO_RESULT_MS || i.sincePostMs >= RUN_LIMIT_MS;
}

/** One notice per plugin version: the server is older and this version has not said so yet. */
export function noticeDue(i: { own: string; server: string | null; seenVersion: string }): boolean {
  if (i.server === null) return false;
  return compareSemVer(i.server, i.own) < 0 && i.seenVersion !== i.own;
}
