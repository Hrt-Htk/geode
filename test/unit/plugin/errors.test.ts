import { assertEquals } from "@std/assert";
import { formatUserError, isAdminAuthFailure } from "../../../plugin/plumbing/errors.ts";

Deno.test("formatUserError - JSON-body HTTP error extracts server message", () => {
  const err = new Error(
    `POST http://geode.example.com/vaults failed: 401 {"error":"invalid token"}`,
  );
  assertEquals(formatUserError(err), "Server error (401): invalid token");
});

Deno.test("formatUserError - non-JSON-body HTTP error hides body", () => {
  const err = new Error(
    `GET http://example.com/vaults failed: 500 Internal Server Error`,
  );
  assertEquals(formatUserError(err), "Server error (500)");
});

Deno.test("formatUserError - plain Error passthrough", () => {
  const err = new Error("vault must be unlocked before resync");
  assertEquals(formatUserError(err), "vault must be unlocked before resync");
});

Deno.test("formatUserError - non-Error value", () => {
  assertEquals(formatUserError("something went wrong"), "something went wrong");
  assertEquals(formatUserError(42), "42");
});

Deno.test("formatUserError - DELETE method HTTP error", () => {
  const err = new Error(
    `DELETE http://server.local/vaults/v1/devices/d1 failed: 403 {"error":"forbidden"}`,
  );
  assertEquals(formatUserError(err), "Server error (403): forbidden");
});

Deno.test("formatUserError - JSON body without error field", () => {
  const err = new Error(
    `POST http://server.local/vaults failed: 400 {"detail":"bad request"}`,
  );
  assertEquals(formatUserError(err), "Server error (400)");
});

// #677: a rotated admin token answers 401: the caller drops the cached token so the next
// privileged action asks again instead of failing forever.
Deno.test("isAdminAuthFailure - only a 401 drops the cached admin token", () => {
  const httpError = (method: string, status: number) =>
    new Error(
      `${method} http://server.local/vaults/v1/trash/h/purge failed: ${status} {"error":"x"}`,
    );
  assertEquals(isAdminAuthFailure(httpError("POST", 401)), true);
  assertEquals(isAdminAuthFailure(httpError("DELETE", 401)), true);
  // Too many attempts keeps the token: it may well be the right one.
  assertEquals(isAdminAuthFailure(httpError("POST", 429)), false);
  assertEquals(isAdminAuthFailure(httpError("POST", 403)), false);
  assertEquals(isAdminAuthFailure(httpError("POST", 500)), false);
  // Anything that is not an HTTP failure is not an admin-token verdict.
  assertEquals(isAdminAuthFailure(new Error("vault locked")), false);
  assertEquals(isAdminAuthFailure("401"), false);
});
