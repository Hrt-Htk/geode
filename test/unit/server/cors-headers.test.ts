import { assert } from "@std/assert";
import { withCors } from "../../../server/http-helpers.ts";

// The plugin's mobile path uses fetch from the Capacitor WebView (origin app://obsidian.md),
// so any custom request header needs a matching Access-Control-Allow-Headers entry or the
// preflight fails and the call surfaces as "TypeError: Failed to fetch" on the phone only.
const CLIENT_HEADERS = [
  "authorization",
  "content-type",
  "x-geode-auth-key",
  "x-geode-admin-token",
];

Deno.test("cors - allow-headers cover every custom header the plugin sends", () => {
  const headers = withCors(new Response(null, { status: 204 })).headers;
  const allowed = (headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
  for (const header of CLIENT_HEADERS) {
    assert(allowed.includes(header), `preflight must allow ${header}, got: ${allowed.join(",")}`);
  }
});
