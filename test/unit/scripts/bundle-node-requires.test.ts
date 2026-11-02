// #15: a plugin bundle that requires a Node module at load cannot run on mobile, where
// Node's modules do not exist.

import { assertEquals } from "@std/assert";
import { findLoadTimeNodeRequires } from "../../../scripts/bundle-node-requires.ts";

Deno.test("bundle-node-requires - the pre-#15 bundle's load-time requires are found", () => {
  const bundle = [
    'var import_promises = require("node:fs/promises");',
    'var import_node_path = __toESM(require("node:path"));',
  ].join("\n");
  assertEquals(findLoadTimeNodeRequires(bundle), [
    'var import_promises = require("node:fs/promises");',
    'var import_node_path = __toESM(require("node:path"));',
  ]);
});

Deno.test("bundle-node-requires - a bare builtin required at load is found", () => {
  assertEquals(findLoadTimeNodeRequires('var fs = require("fs");'), ['var fs = require("fs");']);
});

Deno.test("bundle-node-requires - a lazy require inside a function is not at load", () => {
  const bundle =
    '  const path = await Promise.resolve().then(() => __toESM(require("node:path")));';
  assertEquals(findLoadTimeNodeRequires(bundle), []);
});

Deno.test("bundle-node-requires - libsodium's node environment probe is not at load", () => {
  const bundle = [
    "              if (ENVIRONMENT_IS_NODE2) {",
    '                var fs2 = require("fs");',
    "              }",
  ].join("\n");
  assertEquals(findLoadTimeNodeRequires(bundle), []);
});

Deno.test("bundle-node-requires - external plugin dependencies are not Node modules", () => {
  assertEquals(findLoadTimeNodeRequires('var import_obsidian = require("obsidian");'), []);
});
