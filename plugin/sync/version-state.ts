/** Client version-status model: no obsidian import (safe for deno unit tests). */
import { compareSemVer, parseSemVer } from "../../core/version.ts";

/** #625: which side of the pair the server refused: this plugin, or the server itself. */
export type BlockedSide = "plugin" | "server";

interface VersionPair {
  own: string;
  server: string;
}

export type VersionStatus =
  | { kind: "ok" }
  | ({ kind: "hint" } & VersionPair)
  | { kind: "blocked"; side: BlockedSide };

/**
 * #625: the refusal reason names the side: a minimum-version refusal means the
 * plugin, a protocol refusal the lower protocol number. The server's own parseable
 * version is only the fallback.
 */
export function blockedSide(own: string, server: string, reason = ""): BlockedSide {
  if (reason.includes("below minimum")) return "plugin";
  const protocol = /server (\d+), client (\d+)/.exec(reason);
  if (protocol) return Number(protocol[2]) > Number(protocol[1]) ? "server" : "plugin";
  if (parseSemVer(server) && compareSemVer(server, own) < 0) return "server";
  return "plugin";
}

/** #529: one-line hint for a compatible but different plugin/server pair; null when versions match. */
export function describeVersionHint(own: string, server: string): string | null {
  const c = compareSemVer(server, own);
  if (c === 0) return null;
  return c > 0 ? "Plugin update available" : "Server update available";
}
