// #22: the release asset's manifest.json is stamped with the released version,
// while the root manifest.json keeps the last promoted version the community
// directory reads. The build must not copy the root manifest verbatim.

import { assertEquals } from "@std/assert";
import { stampManifest } from "../../../scripts/manifest-stamp.ts";

const ROOT_MANIFEST = JSON.stringify({
  id: "geode",
  name: "Geode",
  version: "0.41.8",
  minAppVersion: "1.8.7",
  main: "main.js",
});

Deno.test("stampManifest: the released version overrides the promoted one", () => {
  const stamped = JSON.parse(stampManifest(ROOT_MANIFEST, "0.42.0"));
  assertEquals(stamped.version, "0.42.0");
});

Deno.test("stampManifest: every other field comes from the root manifest", () => {
  const stamped = JSON.parse(stampManifest(ROOT_MANIFEST, "0.42.0"));
  assertEquals(stamped, {
    id: "geode",
    name: "Geode",
    version: "0.42.0",
    minAppVersion: "1.8.7",
    main: "main.js",
  });
});

Deno.test("stampManifest: output is the repo's JSON shape (2 spaces, trailing newline)", () => {
  assertEquals(stampManifest('{"version":"0.0.1"}', "0.0.2"), '{\n  "version": "0.0.2"\n}\n');
});
