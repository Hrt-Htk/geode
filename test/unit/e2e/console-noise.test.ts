// #624: `consoleErrors()` must only carry errors that came from Geode, so an
// Obsidian/Capacitor noise line cannot fail a spec, while a real Geode error still does.
import { assertEquals } from "@std/assert";
import { isGeodeConsoleError } from "../../../test/e2e/helpers/console-noise.ts";

// Obsidian loads plugin main.js with the sourceURL `plugin:<id>`, so every Geode frame is
// `plugin:geode:<line>:<col>`. Captured from a real desktop run with an injected onload throw.
const GEODE_CONSOLE_ERROR =
  "Plugin failure: geode Error: PROBE_INJECTED_GEODE_ERROR\n    at GeodePlugin.onload (plugin:geode:57638:11)\n    at GeodePlugin.<anonymous> (app://obsidian.md/app.js:1:2946742)\n    at app://obsidian.md/app.js:1:254188";

const APP_JS_STACK =
  "at app://obsidian.md/app.js:1:254188\n    at Object.next (app://obsidian.md/app.js:1:254293)";

Deno.test("keeps a Geode error surfaced by Obsidian's plugin loader", () => {
  assertEquals(isGeodeConsoleError({ text: GEODE_CONSOLE_ERROR }), true);
});

Deno.test("keeps a Geode error whose pageerror stack has a plugin frame", () => {
  assertEquals(
    isGeodeConsoleError({
      text: "TypeError: Cannot read properties of undefined (reading 'hash')",
      stack:
        "TypeError: Cannot read properties of undefined (reading 'hash')\n    at applyVersion (plugin:geode:81234:17)\n    at async Replicator.drain (plugin:geode:81002:5)",
    }),
    true,
  );
});

Deno.test("keeps Geode logger output, which is prefixed [geode]", () => {
  assertEquals(
    isGeodeConsoleError({ text: '[geode] [error] transport closed {"code":1006}' }),
    true,
  );
});

Deno.test("drops Obsidian's own RangeError from saveHistory/onUnloadFile", () => {
  assertEquals(
    isGeodeConsoleError({
      text:
        "RangeError: Field is not present in this state\n    at EditorState.field (app://obsidian.md/app.js:1:1122334)",
      stack: `RangeError: Field is not present in this state\n    ${APP_JS_STACK}`,
    }),
    false,
  );
});

Deno.test("drops the Capacitor FS bridge 'File does not exist' error", () => {
  assertEquals(
    isGeodeConsoleError({
      text: "File does not exist at win.androidBridge.onmessage",
      stack:
        "Error: File does not exist\n    at capacitor://localhost/native-bridge.js:1:22014\n    at win.androidBridge.onmessage (capacitor://localhost/native-bridge.js:1:21890)",
    }),
    false,
  );
});

Deno.test("drops Obsidian's indexer failure", () => {
  assertEquals(
    isGeodeConsoleError({
      text: "Failed to index seed/assets/chart.canvas",
      stack: `Error: Failed to index\n    ${APP_JS_STACK}`,
    }),
    false,
  );
});

Deno.test("drops a 404 resource-load error (replaces the phone's ad-hoc 404 skip)", () => {
  assertEquals(
    isGeodeConsoleError({
      text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
    }),
    false,
  );
});

Deno.test("a noise-sounding message still fails the spec when a Geode frame is present", () => {
  assertEquals(
    isGeodeConsoleError({
      text: "Failed to index",
      stack: "Error: Failed to index\n    at indexQueue (plugin:geode:70111:9)",
    }),
    true,
  );
});

Deno.test("drops errors with no Geode frame at all", () => {
  assertEquals(isGeodeConsoleError({ text: "boom" }), false);
});
