// #559: obsidian-free logic for the change-passphrase / re-key modal: form
// validation, the run state machine, the copy/replace choice, and every user
// string. Copy rule: plain, one line, no hyphens or dashes.
import type { RekeyKind, RekeyMode } from "../sync/rekey-run.ts";
import { ENCRYPTION_PARAMS, type EncryptionLevel } from "./setup-wizard-logic.ts";

export type { RekeyKind } from "../sync/rekey-run.ts";

// ── Copy ────────────────────────────────────────────────────────────────────

export const REKEY_TITLES: Record<RekeyKind, string> = {
  change: "Change passphrase",
  rekey: "Rekey vault",
};

export const CURRENT_PASSPHRASE_LABEL = "Current passphrase";
export const NEW_PASSPHRASE_LABEL = "New passphrase";
export const CONFIRM_PASSPHRASE_LABEL = "Confirm new passphrase";
export const CHANGE_WARNING =
  "Your server copy will be encrypted again and every other device will enter the new passphrase. Your local notes are not affected.";
export const REKEY_WARNING =
  "This upgrades your vault key derivation and encrypts your server copy again. Every other device will enter the passphrase again.";
export const CHECKBOX_CHANGE =
  "I understand every device must enter the new passphrase and the server copy will be encrypted again.";
export const CHECKBOX_REKEY =
  "I understand the server copy will be encrypted again and every device will enter the passphrase again.";
export const COPY_OPTION_NAME = "Copy";
export const COPY_OPTION_DESC =
  "The vault keeps working while it runs. Needs about the vault size free on the server.";
export const REPLACE_OPTION_NAME = "Replace";
export const REPLACE_OPTION_DESC =
  "The vault can't sync on any device until it finishes, and it can't be cancelled.";
export const ESTIMATING = "Estimating the time…";
export const CONTINUE_BUTTON = "Continue";
export const START_BUTTON = "Start";
export const RUN_TITLE = "Rekeying vault…";
export const KEEP_OPEN_LINE = "Keep the app open until it finishes.";
export const PAUSE_BUTTON = "Pause";
export const RESUME_BUTTON = "Resume";
export const CANCEL_BUTTON = "Cancel";
export const RETRY_BUTTON = "Retry";
export const DONE_BUTTON = "Done";
export const PAUSED_LINE = "Rekey paused";
export const RESUME_FORM_TITLE = "Resume the rekey";
export const SAVE_FAILED_LINE = "Saving the new keys failed.";
export const SUCCESS_LINES: Record<RekeyKind, string> = {
  change: "Passphrase changed.",
  rekey: "Vault rekeyed.",
};
export const SUCCESS_SUBLINE = "Your other devices will ask for it.";

// Settings rows.
export const PASSPHRASE_ROW_NAME = "Passphrase";
export const PASSPHRASE_ROW_DESC = "The passphrase that unlocks this vault.";
export const CHANGE_ROW_BUTTON = "Change…";
export const RESUME_ROW_BUTTON = "Resume…";
export const STRENGTH_ROW_NAME = "Encryption strength";
export const REKEY_ROW_BUTTON = "Rekey…";
export const RESUME_ROW_DESC = "Rekey paused · Resume…";
export const STRENGTH_CUSTOM = "Custom";

// ── Form validation ─────────────────────────────────────────────────────────

export interface RekeyFormValues {
  current: string;
  next: string;
  confirm: string;
  level: EncryptionLevel;
}

const MIN_NEW_PASSPHRASE = 12;

/** Live inline hint while typing (the mismatch, per the #442 design). */
export function rekeyFormHint(kind: RekeyKind, values: RekeyFormValues): string | null {
  if (kind !== "change") return null;
  if (values.next !== values.confirm) return "New passphrases don't match.";
  return null;
}

/** CTA gate: current entered, and new == confirm for change. The 12-char rule
 *  is submit-time, not a gate (#442 decision). */
export function rekeyFormGate(kind: RekeyKind, values: RekeyFormValues): boolean {
  if (!values.current) return false;
  if (kind === "change") return values.next === values.confirm;
  return true;
}

/** Submit-time errors: required current, then the 12-char floor for change. */
export function rekeySubmitError(kind: RekeyKind, values: RekeyFormValues): string | null {
  if (!values.current) return "Enter your current passphrase.";
  if (kind === "change") {
    if (values.next !== values.confirm) return "New passphrases don't match.";
    if (values.next.length < MIN_NEW_PASSPHRASE) {
      return "New passphrase must be at least 12 characters.";
    }
  }
  return null;
}

/** The stored argon2 params as a strength level, or null when the vault uses
 *  custom params the wizard never offered. */
export function strengthLevelOf(params: { ops: number; mem: number }): EncryptionLevel | null {
  const entries = Object.entries(ENCRYPTION_PARAMS) as [
    EncryptionLevel,
    { ops: number; mem: number },
  ][];
  for (const [level, p] of entries) {
    if (p.ops === params.ops && p.mem === params.mem) return level;
  }
  return null;
}

// ── State machine ───────────────────────────────────────────────────────────

// resume: passphrase re-entry after a reload (the vault is still on the old
// keys until the switch). save-failed: the server switch is done, only the
// local persist failed.
export type RekeyPhase =
  | "form"
  | "choose"
  | "resume"
  | "running"
  | "paused"
  | "failed"
  | "save-failed"
  | "done";

export interface RekeyUiState {
  phase: RekeyPhase;
  kind: RekeyKind;
  mode: RekeyMode | null;
  failReason: string | null;
}

export type RekeyEvent =
  | { type: "continue" }
  | { type: "start"; mode: RekeyMode }
  | { type: "resumed" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "fail"; reason: string }
  | { type: "done" }
  | { type: "save-failed"; reason: string }
  | { type: "cancel" }
  | { type: "retry" };

export function initialRekeyUiState(kind: RekeyKind): RekeyUiState {
  return { phase: "form", kind, mode: null, failReason: null };
}

// The phase each event is legal in; any other phase is a no-op. A late abort
// landing after a cancel (phase back at form) is therefore a no-op too.
const EVENT_PHASES: Record<RekeyEvent["type"], RekeyPhase[]> = {
  continue: ["form"],
  start: ["choose"],
  resumed: ["resume"],
  pause: ["running"],
  resume: ["paused"],
  fail: ["running", "paused"],
  done: ["running", "paused", "save-failed"],
  "save-failed": ["done"],
  cancel: ["running", "paused", "failed"],
  retry: ["failed"],
};

/** Pure transition. Events outside their phase return the state unchanged;
 *  cancel is additionally copy-mode only (replace can't be cancelled). */
export function rekeyUiTransition(state: RekeyUiState, event: RekeyEvent): RekeyUiState {
  if (!EVENT_PHASES[event.type].includes(state.phase)) return state;
  if (event.type === "cancel" && state.mode !== "copy") return state;
  const next: RekeyUiState = { ...state };
  switch (event.type) {
    case "continue":
      next.phase = "choose";
      break;
    case "start":
      next.phase = "running";
      next.mode = event.mode;
      next.failReason = null;
      break;
    case "resumed":
      next.phase = "paused";
      break;
    case "pause":
      next.phase = "paused";
      break;
    case "resume":
      next.phase = "running";
      break;
    case "fail":
      next.phase = "failed";
      next.failReason = event.reason;
      break;
    case "done":
      next.phase = "done";
      break;
    case "save-failed":
      next.phase = "save-failed";
      next.failReason = event.reason;
      break;
    case "cancel":
      next.phase = "form";
      next.mode = null;
      next.failReason = null;
      break;
    case "retry":
      next.phase = "running";
      next.failReason = null;
      break;
  }
  return next;
}

// ── Progress line ───────────────────────────────────────────────────────────

/** One line per phase; the blobs phase carries the live ETA (#558). */
export function rekeyProgressLine(
  phase: "blobs" | "rows" | "switch",
  done: number,
  total: number,
  eta: string | null,
): string {
  if (phase === "switch") return "Switching the vault over";
  // Rounds down so the line never reads 100% before the phase finishes.
  const pct = Math.floor((done / total) * 100);
  if (phase === "rows") return `Finalizing ${pct}%`;
  return eta ? `Rekeying ${pct}% · ${eta}` : `Rekeying ${pct}%`;
}
