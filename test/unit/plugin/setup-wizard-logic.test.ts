import { assert, assertEquals } from "@std/assert";
import { NEW_VAULT_ARGON2_PARAMS } from "../../../plugin/plumbing/settings-types.ts";
import {
  backStep,
  classifyServerError,
  ENCRYPTION_PARAMS,
  mapJoinError,
  serverErrorText,
  STRENGTH_DETAIL,
  STRENGTH_NOTE,
  STRENGTH_OPTIONS,
  validateCreateForm,
  wizardTitle,
} from "../../../plugin/ui/setup-wizard-logic.ts";

// ── #457: encryption strength → argon2 params ──

Deno.test("ENCRYPTION_PARAMS - lower is 3 passes / 64 MiB", () => {
  assertEquals(ENCRYPTION_PARAMS.lower, { ops: 3, mem: 64 * 1024 * 1024 });
});

Deno.test("ENCRYPTION_PARAMS - standard matches NEW_VAULT_ARGON2_PARAMS (3 / 256 MiB)", () => {
  assertEquals(ENCRYPTION_PARAMS.standard, NEW_VAULT_ARGON2_PARAMS);
});

Deno.test("ENCRYPTION_PARAMS - higher is 4 passes / 512 MiB", () => {
  assertEquals(ENCRYPTION_PARAMS.higher, { ops: 4, mem: 512 * 1024 * 1024 });
});

Deno.test("STRENGTH_OPTIONS - standard is the default label", () => {
  assertEquals(STRENGTH_OPTIONS.standard, "Standard (default)");
});

// ── copy rule: no hyphens or dashes in any user-visible string ──

const DASH = /[\u2013\u2014-]/;

Deno.test("wizard copy - no hyphens or dashes anywhere user-visible", () => {
  const strings = [
    ...Object.values(STRENGTH_OPTIONS),
    ...Object.values(STRENGTH_DETAIL),
    STRENGTH_NOTE,
    "Set up Geode",
    "Create new Geode vault",
    "Join existing Geode vault",
    "Enter a vault name.",
    "Passphrases don't match.",
    "Passphrase is too short.",
    "That admin token isn't valid.",
    "That passphrase doesn't match this vault.",
    "Couldn't reach the server at example.com.",
    "Server error. Try again later.",
    "Enter a device name.",
    "The token you created when you installed the server.",
  ];
  for (const s of strings) {
    assert(!DASH.test(s), `dash found in user-visible string: ${JSON.stringify(s)}`);
  }
});

// ── step machine ──

Deno.test("wizardTitle - follows the flow", () => {
  assertEquals(wizardTitle(null), "Set up Geode");
  assertEquals(wizardTitle("create"), "Create new Geode vault");
  assertEquals(wizardTitle("join"), "Join existing Geode vault");
});

Deno.test("backStep - create and join both walk back to choose", () => {
  assertEquals(backStep("create-vault"), "create-server");
  assertEquals(backStep("create-server"), "choose");
  assertEquals(backStep("join-vault"), "join-server");
  assertEquals(backStep("join-server"), "choose");
});

Deno.test("backStep - no back from choose or done", () => {
  assertEquals(backStep("choose"), null);
  assertEquals(backStep("done"), null);
});

// ── create-form validation ──

Deno.test("validateCreateForm - requires a vault name", () => {
  assertEquals(
    validateCreateForm({ vaultName: "  ", passphrase: "x".repeat(12), confirm: "x".repeat(12) }),
    "Enter a vault name.",
  );
});

Deno.test("validateCreateForm - rejects mismatched passphrases", () => {
  assertEquals(
    validateCreateForm({ vaultName: "v", passphrase: "abcdefghijkl", confirm: "abcdefghijklX" }),
    "Passphrases don't match.",
  );
});

Deno.test("validateCreateForm - rejects passphrases shorter than 12 chars", () => {
  assertEquals(
    validateCreateForm({ vaultName: "v", passphrase: "x".repeat(11), confirm: "x".repeat(11) }),
    "Passphrase is too short.",
  );
});

Deno.test("validateCreateForm - accepts a valid form", () => {
  assertEquals(
    validateCreateForm({ vaultName: "vault", passphrase: "x".repeat(12), confirm: "x".repeat(12) }),
    null,
  );
});

// ── server / token error mapping ──

Deno.test("classifyServerError - 401 and 403 are invalid token", () => {
  assertEquals(
    classifyServerError(new Error('GET http://x/vaults failed: 401 {"error":"invalid token"}')),
    "invalid-token",
  );
  assertEquals(
    classifyServerError(new Error("GET http://x/vaults failed: 403 forbidden")),
    "invalid-token",
  );
});

Deno.test("classifyServerError - status 0 and network errors are unreachable", () => {
  assertEquals(classifyServerError(new Error("GET http://x/vaults failed: 0 ")), "unreachable");
  assertEquals(classifyServerError(new TypeError("Failed to fetch")), "unreachable");
});

Deno.test("classifyServerError - 5xx is a server error, not unreachable", () => {
  assertEquals(
    classifyServerError(new Error("GET http://x/vaults failed: 500 boom")),
    "server-error",
  );
  assertEquals(
    classifyServerError(new Error("POST http://x/devices failed: 503 unavailable")),
    "server-error",
  );
});

Deno.test("serverErrorText - invalid token, unreachable, and server-error copy", () => {
  assertEquals(serverErrorText("invalid-token", "example.com"), "That admin token isn't valid.");
  assertEquals(
    serverErrorText("unreachable", "example.com"),
    "Couldn't reach the server at example.com.",
  );
  assertEquals(serverErrorText("server-error", "example.com"), "Server error. Try again later.");
});

// ── join submit error mapping ──

Deno.test("mapJoinError - incorrect passphrase maps to vault mismatch", () => {
  assertEquals(
    mapJoinError(new Error("incorrect passphrase"), "example.com"),
    "That passphrase doesn't match this vault.",
  );
});

Deno.test("mapJoinError - network failure maps to unreachable", () => {
  assertEquals(
    mapJoinError(new Error("GET http://x/vaults/1/info failed: 0 "), "example.com"),
    "Couldn't reach the server at example.com.",
  );
});

Deno.test("mapJoinError - other HTTP failures fall through to the server error", () => {
  assertEquals(
    mapJoinError(
      new Error('GET http://x/vaults/1/info failed: 404 {"error":"not found"}'),
      "example.com",
    ),
    "Server error (404): not found",
  );
});
