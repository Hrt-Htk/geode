// Plugin version gate: minimum-version enforcement + wire-protocol check.
// #529: a plain plugin/server version difference is allowed (compatible): the
// client shows an update hint instead of being blocked. A hard gate failure
// (protocol / minimum version) sends server_version_mismatch before closing, so
// an installed client blocks with an update prompt (#625).
import type { Database } from "@db/sqlite";
import { PROTOCOL_VERSION, UPDATE_REQUIRED } from "../core/protocol.ts";
import { meetsMinimum } from "../core/version.ts";
import pkg from "../package.json" with { type: "json" };

export const SERVER_VERSION = pkg.version;

export type GateResult = { ok: boolean; reason?: string };

export function checkMinVersion(
  pluginVersion: string,
  // Read per handshake: the deployment's minimum, not a module-load snapshot.
  minimum: string = Deno.env.get("GEODE_MIN_PLUGIN_VERSION") ?? "0.0.0",
): GateResult {
  if (meetsMinimum(pluginVersion, minimum)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `plugin version ${
      pluginVersion || "unknown"
    } below minimum ${minimum}: ${UPDATE_REQUIRED}`,
  };
}

export function updateDevicePluginVersion(
  db: Database,
  deviceId: string,
  version: string,
): void {
  db.prepare("UPDATE devices SET plugin_version = ? WHERE id = ?").run(version, deviceId);
}

export function checkProtocolVersion(
  clientProtocol: number,
  expected: number = PROTOCOL_VERSION,
): GateResult {
  if (clientProtocol === expected) return { ok: true };
  return {
    ok: false,
    reason: `protocol version mismatch: server ${expected}, client ${
      clientProtocol ?? "unknown"
    }: ${UPDATE_REQUIRED}`,
  };
}
