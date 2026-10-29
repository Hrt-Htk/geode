import { assertEquals } from "@std/assert";
import {
  initialRekeyUiState,
  rekeyFormGate,
  rekeyFormHint,
  rekeyProgressLine,
  rekeySubmitError,
  type RekeyUiState,
  rekeyUiTransition,
  strengthLevelOf,
} from "../../../plugin/ui/rekey-modal-logic.ts";
import { ENCRYPTION_PARAMS } from "../../../plugin/ui/setup-wizard-logic.ts";

const validChange = {
  current: "correct horse battery staple",
  next: "new passphrase here",
  confirm: "new passphrase here",
  level: "standard" as const,
};
const validRekey = {
  current: "correct horse battery staple",
  next: "",
  confirm: "",
  level: "higher" as const,
};

Deno.test("rekey form gate - change needs current and a match", () => {
  assertEquals(rekeyFormGate("change", { ...validChange, current: "" }), false);
  assertEquals(rekeyFormGate("change", { ...validChange, confirm: "other" }), false);
  assertEquals(rekeyFormGate("change", validChange), true);
});

Deno.test("rekey form gate - rekey needs only the current passphrase", () => {
  assertEquals(rekeyFormGate("rekey", { ...validRekey, current: "" }), false);
  assertEquals(rekeyFormGate("rekey", validRekey), true);
});

Deno.test("rekey live hint - mismatch only, change only", () => {
  assertEquals(
    rekeyFormHint("change", { ...validChange, confirm: "other" }),
    "New passphrases don't match.",
  );
  assertEquals(rekeyFormHint("change", validChange), null);
  assertEquals(rekeyFormHint("rekey", { ...validRekey, next: "a", confirm: "b" }), null);
});

Deno.test("rekey submit errors - current required, 12 chars at submit, not a gate", () => {
  assertEquals(
    rekeySubmitError("change", { ...validChange, current: "" }),
    "Enter your current passphrase.",
  );
  assertEquals(
    rekeySubmitError("change", { ...validChange, next: "short", confirm: "short" }),
    "New passphrase must be at least 12 characters.",
  );
  assertEquals(
    rekeySubmitError("change", { ...validChange, next: "x".repeat(11), confirm: "x".repeat(11) }),
    "New passphrase must be at least 12 characters.",
  );
  assertEquals(
    rekeySubmitError("change", { ...validChange, next: "x".repeat(12), confirm: "x".repeat(12) }),
    null,
  );
  assertEquals(
    rekeySubmitError("rekey", { ...validRekey, current: "" }),
    "Enter your current passphrase.",
  );
  assertEquals(rekeySubmitError("rekey", validRekey), null);
});

Deno.test("strengthLevelOf - maps stored params to a level, null when custom", () => {
  assertEquals(strengthLevelOf(ENCRYPTION_PARAMS.lower), "lower");
  assertEquals(strengthLevelOf(ENCRYPTION_PARAMS.standard), "standard");
  assertEquals(strengthLevelOf(ENCRYPTION_PARAMS.higher), "higher");
  assertEquals(strengthLevelOf({ ops: 1, mem: 1024 }), null);
});

Deno.test("rekey state machine - happy path form to done", () => {
  let s: RekeyUiState = initialRekeyUiState("change");
  assertEquals(s.phase, "form");
  s = rekeyUiTransition(s, { type: "continue" });
  assertEquals(s.phase, "choose");
  s = rekeyUiTransition(s, { type: "start", mode: "copy" });
  assertEquals(s.phase, "running");
  assertEquals(s.mode, "copy");
  s = rekeyUiTransition(s, { type: "pause" });
  assertEquals(s.phase, "paused");
  s = rekeyUiTransition(s, { type: "resume" });
  assertEquals(s.phase, "running");
  s = rekeyUiTransition(s, { type: "done" });
  assertEquals(s.phase, "done");
});

Deno.test("rekey state machine - failure and retry", () => {
  let s: RekeyUiState = initialRekeyUiState("rekey");
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "replace" });
  s = rekeyUiTransition(s, { type: "fail", reason: "Server error (500): boom" });
  assertEquals(s.phase, "failed");
  assertEquals(s.failReason, "Server error (500): boom");
  s = rekeyUiTransition(s, { type: "retry" });
  assertEquals(s.phase, "running");
  assertEquals(s.failReason, null);
});

Deno.test("rekey state machine - resume after reload: resume form to paused", () => {
  let s: RekeyUiState = { ...initialRekeyUiState("change"), phase: "resume", mode: "copy" };
  assertEquals(s.phase, "resume");
  s = rekeyUiTransition(s, { type: "resumed" });
  assertEquals(s.phase, "paused");
  // resumed is only legal from the resume form
  const form = initialRekeyUiState("change");
  assertEquals(rekeyUiTransition(form, { type: "resumed" }), form);
});

Deno.test("rekey state machine - save failed after the switch, retry persist to done", () => {
  let s: RekeyUiState = initialRekeyUiState("change");
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "copy" });
  s = rekeyUiTransition(s, { type: "done" });
  s = rekeyUiTransition(s, { type: "save-failed", reason: "Saving settings failed." });
  assertEquals(s.phase, "save-failed");
  assertEquals(s.failReason, "Saving settings failed.");
  // the persist retry lands on done; save-failed is not a run failure
  s = rekeyUiTransition(s, { type: "done" });
  assertEquals(s.phase, "done");
  // save-failed is only legal from done (the switch already happened)
  let running = initialRekeyUiState("change");
  running = rekeyUiTransition(running, { type: "continue" });
  running = rekeyUiTransition(running, { type: "start", mode: "copy" });
  const fromRunning = rekeyUiTransition(running, { type: "save-failed", reason: "x" });
  assertEquals(fromRunning.phase, "running");
});

Deno.test("rekey state machine - cancel only in copy mode, back to form", () => {
  let s: RekeyUiState = initialRekeyUiState("change");
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "copy" });
  s = rekeyUiTransition(s, { type: "cancel" });
  assertEquals(s.phase, "form");
  assertEquals(s.mode, null);
  // failed copy mode can cancel too
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "copy" });
  s = rekeyUiTransition(s, { type: "fail", reason: "x" });
  s = rekeyUiTransition(s, { type: "cancel" });
  assertEquals(s.phase, "form");
});

Deno.test("rekey state machine - cancel is a no-op in replace mode and outside run phases", () => {
  let s: RekeyUiState = initialRekeyUiState("rekey");
  s = rekeyUiTransition(s, { type: "cancel" });
  assertEquals(s.phase, "form");
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "replace" });
  const running = rekeyUiTransition(s, { type: "cancel" });
  assertEquals(running, s, "replace mode stays running");
  const done = rekeyUiTransition(s, { type: "done" });
  assertEquals(rekeyUiTransition(done, { type: "cancel" }), done, "done is terminal");
});

Deno.test("rekey state machine - a late abort after cancel is a no-op (cancel race)", () => {
  let s: RekeyUiState = initialRekeyUiState("change");
  s = rekeyUiTransition(s, { type: "continue" });
  s = rekeyUiTransition(s, { type: "start", mode: "copy" });
  s = rekeyUiTransition(s, { type: "cancel" });
  assertEquals(s.phase, "form");
  // the worker's in-flight abort lands after the cancel: pause/fail must not
  // drag the view back into a run phase
  assertEquals(rekeyUiTransition(s, { type: "pause" }), s);
  assertEquals(rekeyUiTransition(s, { type: "fail", reason: "late" }), s);
});

Deno.test("rekey state machine - invalid transitions are no-ops", () => {
  const form = initialRekeyUiState("change");
  assertEquals(rekeyUiTransition(form, { type: "start", mode: "copy" }), form);
  assertEquals(rekeyUiTransition(form, { type: "pause" }), form);
  assertEquals(rekeyUiTransition(form, { type: "resume" }), form);
  assertEquals(rekeyUiTransition(form, { type: "done" }), form);
  assertEquals(rekeyUiTransition(form, { type: "retry" }), form);
  const choose = rekeyUiTransition(form, { type: "continue" });
  assertEquals(rekeyUiTransition(choose, { type: "continue" }), choose);
  const running = rekeyUiTransition(choose, { type: "start", mode: "copy" });
  assertEquals(rekeyUiTransition(running, { type: "continue" }), running);
  assertEquals(rekeyUiTransition(running, { type: "start", mode: "replace" }), running);
});

Deno.test("rekey progress line - one line per phase, no dashes", () => {
  assertEquals(
    rekeyProgressLine("blobs", 38, 100, "About 4:32 left"),
    "Rekeying 38% · About 4:32 left",
  );
  assertEquals(rekeyProgressLine("blobs", 38, 100, null), "Rekeying 38%");
  // Rounds down: 99.9% must not read as 100% while a chunk is still owed.
  assertEquals(rekeyProgressLine("blobs", 999, 1000, null), "Rekeying 99%");
  assertEquals(rekeyProgressLine("rows", 72, 100, null), "Finalizing 72%");
  assertEquals(rekeyProgressLine("switch", 0, 1, null), "Switching the vault over");
});
