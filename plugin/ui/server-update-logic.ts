/** #44/#51: the plugin's server update as decisions: the Server version row's copy and control,
 * the job's result words as one line, failure classification, the stale-result rule, the polling
 * deadlines, and whether the one time notice is due. No obsidian import (safe for deno tests). */
import { compareSemVer } from "../../core/version.ts";
import type { JobResult, JobStatus } from "../plumbing/update-client.ts";

/** What the no job path copies: the job's own command, run on the server (server.md §11). */
export const SERVER_UPDATE_COMMAND = "docker compose pull && docker compose up -d";
export const GEODE_RELEASES_URL = "https://github.com/Hrt-Htk/geode/releases";

export const UPDATE_ROW_NAME = "Server version";
export const PLUGIN_VERSION_ROW_NAME = "Plugin version";
export const UPDATE_NOTICE = "Server update available.";
export const UPDATE_BUTTON = "Update";
export const UPDATE_WHATS_NEW = "What's new";
export const UPDATE_TITLE_ASK = "Update the Geode server?";
/** A question mark over a run that already started reads wrong: the same dialog, declarative. */
export const UPDATE_TITLE_RUN = "Update the Geode server";
export const UPDATE_CONFIRM_LINES = [
  "Every vault on this server updates.",
  "This device and others may need a plugin update before they sync again.",
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
  text: string;
  /** A run that failed or did not happen shows the command, so it can be finished by hand. */
  showCommand: boolean;
  /** The no-job dialog links to releases so the user can check changes before running the command. */
  showWhatsNew?: boolean;
};

/** A run that never reached a result: the command is the next step. */
export function notRun(): UpdateOutcome {
  return { text: "The update did not run. Copy the command below.", showCommand: true };
}

export type UpdateFailureState = {
  failed: boolean;
  failedEpoch: number;
  lastResultEpoch: number;
};

export const INITIAL_FAILURE_STATE: UpdateFailureState = {
  failed: false,
  failedEpoch: 0,
  lastResultEpoch: 0,
};

/** Record a server /update/status result: only a strictly newer epoch can clear a failure. */
export function noteJobStatus(
  state: UpdateFailureState,
  result: JobResult | null,
): UpdateFailureState {
  if (!result) return state;
  const lastResultEpoch = Math.max(state.lastResultEpoch, result.epoch);
  if (result.epoch <= state.failedEpoch) return { ...state, lastResultEpoch };
  if (result.word === "updated" || result.word === "up-to-date") {
    return { failed: false, failedEpoch: state.failedEpoch, lastResultEpoch };
  }
  if (result.word !== "running" && updateOutcome(result.word, "").showCommand) {
    return { failed: true, failedEpoch: state.failedEpoch, lastResultEpoch };
  }
  return { ...state, lastResultEpoch };
}

/** Mark an update failure at or above every request/result epoch seen so far. */
export function noteUpdateFailure(
  state: UpdateFailureState,
  requestEpoch: number,
): UpdateFailureState {
  return {
    failed: true,
    failedEpoch: Math.max(state.failedEpoch, requestEpoch, state.lastResultEpoch),
    lastResultEpoch: state.lastResultEpoch,
  };
}

/** Mark an update success at `resultEpoch`, clearing any earlier failure. */
export function noteUpdateSuccess(
  state: UpdateFailureState,
  resultEpoch: number,
): UpdateFailureState {
  return {
    failed: false,
    failedEpoch: state.failedEpoch,
    lastResultEpoch: Math.max(state.lastResultEpoch, resultEpoch),
  };
}

/** One result line per word the job writes (server.md §11); `serverVersion` is what it runs now. */
export function updateOutcome(word: string, serverVersion: string): UpdateOutcome {
  switch (word) {
    case "updated":
      return { text: `Server updated to ${serverVersion}.`, showCommand: false };
    case "up-to-date":
      return { text: "Server is already up to date.", showCommand: false };
    case "rate-limited":
      return {
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
        text: `The update failed. The server is back on ${serverVersion}.`,
        showCommand: true,
      };
  }
}

export type ServerUpdateInput = {
  own: string;
  /** The server's own version, learned from hello_ack or a refusal; null until known. */
  server: string | null;
  /** The server refused this plugin: the banner carries the one Update action. */
  refused: boolean;
  updating: boolean;
  /** #51: the last failed update stays visible on the row until a later one works. */
  lastUpdateFailed: boolean;
};

export type ServerUpdateRow =
  | { kind: "plain"; desc: string }
  | { kind: "action"; desc: string; control: "update" | "updating" };

/** The Server version row in Status, once the server's version is known. One Update button
 * whether or not the host job is installed; the dialog shows the command when it is not. */
export function serverUpdateRow(i: ServerUpdateInput & { server: string }): ServerUpdateRow {
  if (compareSemVer(i.server, i.own) >= 0) {
    return { kind: "plain", desc: `${i.server}. Up to date.` };
  }
  if (i.refused) {
    const status = i.lastUpdateFailed ? "Last update failed." : "Too old for this plugin.";
    return { kind: "plain", desc: `${i.server}. ${status}` };
  }
  if (i.updating) {
    return { kind: "action", desc: `${i.server}. Updating.`, control: "updating" };
  }
  if (i.lastUpdateFailed) {
    return { kind: "action", desc: `${i.server}. Last update failed.`, control: "update" };
  }
  return { kind: "action", desc: `${i.server}. Update available.`, control: "update" };
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
