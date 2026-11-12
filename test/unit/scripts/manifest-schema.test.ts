// #20: the community directory reads the root manifest.json at the HEAD of main, and the
// submission review rejects a manifest that misses a required property or adds one the schema
// does not define (a stray `views` key did).

import { assertEquals } from "@std/assert";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../../../manifest.json", import.meta.url)),
) as Record<string, unknown>;

/** en/Reference/Manifest.md: the required plugin properties plus the optional documented ones. */
const REQUIRED = [
  "author",
  "description",
  "id",
  "isDesktopOnly",
  "minAppVersion",
  "name",
  "version",
];
const OPTIONAL = ["authorUrl", "fundingUrl", "helpUrl"];

Deno.test("manifest: carries every required directory property", () => {
  const missing = REQUIRED.filter((key) => !(key in manifest));
  assertEquals(missing, []);
});

Deno.test("manifest: declares isDesktopOnly as a boolean", () => {
  assertEquals(typeof manifest.isDesktopOnly, "boolean");
});

Deno.test("manifest: has no key the directory schema does not define", () => {
  const unknown = Object.keys(manifest).filter(
    (key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key),
  );
  assertEquals(unknown, []);
});
