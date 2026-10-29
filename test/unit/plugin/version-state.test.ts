import { assertEquals } from "@std/assert";
import {
  blockedCopy,
  blockedSide,
  describeVersionHint,
} from "../../../plugin/sync/version-state.ts";

// #625: the blocked state only happens to a client the server refuses: either
// this plugin is too old, or the refusing server is (and only a server that is
// behind refuses a newer plugin).

Deno.test("version-state - blockedSide: the refusal reason names the side", () => {
  // A minimum-version refusal always means the plugin is behind, even when the
  // server's own version is older (a stale server with a newer minimum).
  assertEquals(
    blockedSide(
      "0.37.5",
      "0.37.0",
      "plugin version 0.37.5 below minimum 0.38.0: update required",
    ),
    "plugin",
  );
  // A protocol refusal compares the two protocol numbers, even when the server
  // reports a newer version.
  assertEquals(
    blockedSide(
      "0.36.0",
      "0.37.0",
      "protocol version mismatch: server 4, client 5: update required",
    ),
    "server",
  );
  assertEquals(
    blockedSide(
      "0.37.5",
      "0.37.0",
      "protocol version mismatch: server 5, client 4: update required",
    ),
    "plugin",
  );
});

Deno.test("version-state - blockedSide: a message-only refusal falls back to the version", () => {
  assertEquals(blockedSide("0.36.0", "0.35.0"), "server");
  assertEquals(blockedSide("0.35.0", "0.36.0"), "plugin");
  assertEquals(blockedSide("0.36.0", "0.36.0"), "plugin");
  assertEquals(blockedSide("0.36.0", ""), "plugin");
});

Deno.test("version-state - blockedSide: an unparseable server version is no evidence", () => {
  assertEquals(blockedSide("0.38.0", "0.38.0-rc.1"), "plugin");
  assertEquals(blockedSide("0.38.0", "not-a-version"), "plugin");
});

Deno.test("version-state - blocked copy when the plugin is behind", () => {
  assertEquals(blockedCopy("plugin"), {
    title: "Update required",
    notice: "Geode needs an update to keep syncing. Update the plugin, then reload Obsidian.",
    bannerDesc: "Update the plugin, then reload Obsidian.",
    tooltip: "Geode: update the plugin to keep syncing",
    row: "Update the plugin to keep syncing.",
  });
});

Deno.test("version-state - blocked copy when the server is behind", () => {
  assertEquals(blockedCopy("server"), {
    title: "Server update required",
    notice:
      "The Geode server needs an update to keep syncing. Update the server, then reload Obsidian.",
    bannerDesc: "Update the Geode server, then reload Obsidian.",
    tooltip: "Geode: the server needs an update to keep syncing",
    row: "Update the Geode server to keep syncing.",
  });
});

Deno.test("version-state - hint when server is newer than plugin", () => {
  assertEquals(describeVersionHint("0.5.0", "0.9.2"), "Plugin update available");
});

Deno.test("version-state - hint when server is older than plugin", () => {
  assertEquals(describeVersionHint("0.9.2", "0.5.0"), "Server update available");
});

Deno.test("version-state - no hint when versions match", () => {
  assertEquals(describeVersionHint("0.5.0", "0.5.0"), null);
});

Deno.test("version-state - no hint when both unparseable", () => {
  assertEquals(describeVersionHint("", ""), null);
});
