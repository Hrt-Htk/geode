import {
  checkMinVersion,
  checkProtocolVersion,
  SERVER_VERSION,
} from "../../../server/version-gate.ts";
import type { ServerHelloAck, ServerVersionMismatch } from "../../../core/protocol.ts";
import { PROTOCOL_VERSION } from "../../../core/protocol.ts";
import { assert, assertEquals } from "@std/assert";

// ── checkMinVersion ──────────────────────────────────────────────────

Deno.test("version-gate - checkMinVersion passes when at minimum", () => {
  const result = checkMinVersion("0.5.0", "0.5.0");
  assert(result.ok);
});

Deno.test("version-gate - checkMinVersion passes when above minimum", () => {
  const result = checkMinVersion("1.0.0", "0.5.0");
  assert(result.ok);
});

Deno.test("version-gate - checkMinVersion rejects when below minimum", () => {
  const result = checkMinVersion("0.4.0", "0.5.0");
  assertEquals(result.ok, false);
  assert(result.reason !== undefined);
  assert(result.reason!.includes("0.4.0"));
  assert(result.reason!.includes("0.5.0"));
});

Deno.test("version-gate - checkMinVersion passes unknown version against 0.0.0", () => {
  const result = checkMinVersion("", "0.0.0");
  assert(result.ok);
});

Deno.test("version-gate - checkMinVersion rejects unknown version against non-zero minimum", () => {
  const result = checkMinVersion("", "0.5.0");
  assertEquals(result.ok, false);
});

Deno.test("version-gate - checkMinVersion passes any valid version against 0.0.0", () => {
  const result = checkMinVersion("0.1.0", "0.0.0");
  assert(result.ok);
});

Deno.test("version-gate - checkMinVersion uses env default when no minimum given", () => {
  // With default MIN_PLUGIN_VERSION of "0.0.0", any version should pass
  const result = checkMinVersion("0.1.0");
  assert(result.ok);
});

// ── exact-match gate removed (#529) ─────────────────────────────────

Deno.test("version-gate - exact-match gate removed: no checkServerVersionMatch export", async () => {
  const mod = await import("../../../server/version-gate.ts");
  assertEquals(
    (mod as unknown as Record<string, unknown>).checkServerVersionMatch,
    undefined,
  );
});

// ── SERVER_VERSION source ─────────────────────────────────────────────

Deno.test("version-gate - SERVER_VERSION still exported for hello_ack", async () => {
  const mod = await import("../../../server/version-gate.ts");
  assertEquals((mod as unknown as { SERVER_VERSION: string }).SERVER_VERSION, SERVER_VERSION);
});

Deno.test("version-gate - SERVER_VERSION matches package.json version", async () => {
  const pkgText = await Deno.readTextFile(new URL("../../../package.json", import.meta.url));
  const pkg = JSON.parse(pkgText) as { version: string };
  assertEquals(SERVER_VERSION, pkg.version);
});

Deno.test("version-gate - SERVER_VERSION is a valid semver-like string", () => {
  assert(SERVER_VERSION.length > 0);
  assert(/^\d+\.\d+\.\d+/.test(SERVER_VERSION));
});

Deno.test("version-gate - server_version_mismatch message shape", () => {
  const payload: ServerVersionMismatch = {
    type: "server_version_mismatch",
    server_version: SERVER_VERSION,
    client_version: "0.5.0",
  };
  assert(payload.type === "server_version_mismatch");
  assert(payload.server_version === SERVER_VERSION);
  assertEquals(JSON.parse(JSON.stringify(payload)).type, "server_version_mismatch");
});

Deno.test("version-gate - server_hello_ack carries server_version", () => {
  const ack: ServerHelloAck = {
    type: "server_hello_ack",
    vault_id: "vault-x",
    vault_name: "vault-x",
    seq: 3,
    server_version: SERVER_VERSION,
  };
  assert(ack.server_version === SERVER_VERSION);
});

// ── checkProtocolVersion ─────────────────────────────────────────────

Deno.test("version-gate - checkProtocolVersion passes matching version", () => {
  const result = checkProtocolVersion(PROTOCOL_VERSION);
  assert(result.ok);
});

Deno.test("version-gate - checkProtocolVersion rejects mismatched version", () => {
  const result = checkProtocolVersion(PROTOCOL_VERSION + 1);
  assertEquals(result.ok, false);
  assert(result.reason !== undefined);
  assert(result.reason!.includes("protocol version mismatch"));
});

Deno.test("version-gate - protocol 6 is the restored-mark bump (#687)", () => {
  assertEquals(PROTOCOL_VERSION, 6);
  assertEquals(checkProtocolVersion(5).ok, false, "a protocol-5 client would skip its own restore");
});

Deno.test("version-gate - checkProtocolVersion rejects against explicit expected", () => {
  const result = checkProtocolVersion(1, 2);
  assertEquals(result.ok, false);
});

Deno.test("version-gate - checkProtocolVersion rejects undefined client value", () => {
  const result = checkProtocolVersion(undefined as unknown as number);
  assertEquals(result.ok, false);
  assert(result.reason !== undefined);
  assert(result.reason!.includes("unknown"));
});
