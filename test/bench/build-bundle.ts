// Builds test/bench/crypto-bench.bundle.js: the bench-only IIFE the #457 E2E specs
// inject into the Obsidian renderer. Bundles core/crypto.ts with the same libsodium
// build the plugin ships (plugin/_generated/libsodium-sumo-patched.cjs, produced by
// `deno task build:plugin`), which reuses globalThis.__GEODE_LIBSODIUM_WASM__ that the
// loaded plugin already set.
// Run: deno task build:plugin && deno run -A test/bench/build-bundle.ts
import { build } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";

const rootDir = Deno.cwd();
// The patched libsodium-sumo CJS is dual-env (Emscripten): it require()s node
// builtins behind an ENVIRONMENT_IS_NODE guard, so they stay external like in
// scripts/plugin-build.ts.
const external = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
const aliases = new Map<string, string>([
  ["@noble/hashes/blake3", path.join(rootDir, "node_modules", "@noble", "hashes", "blake3.js")],
  ["@noble/hashes/hkdf", path.join(rootDir, "node_modules", "@noble", "hashes", "hkdf.js")],
  ["@noble/hashes/sha2", path.join(rootDir, "node_modules", "@noble", "hashes", "sha2.js")],
  [
    "libsodium-wrappers-sumo",
    path.join(
      rootDir,
      "node_modules",
      "libsodium-wrappers-sumo",
      "dist",
      "modules-sumo",
      "libsodium-wrappers.js",
    ),
  ],
  ["libsodium-sumo", path.join(rootDir, "plugin", "_generated", "libsodium-sumo-patched.cjs")],
]);

await build({
  entryPoints: [path.join(rootDir, "test", "bench", "crypto-bench-entry.ts")],
  outfile: path.join(rootDir, "test", "bench", "crypto-bench.bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  external,
  logLevel: "info",
  plugins: [
    {
      name: "bench-aliases",
      setup(api) {
        for (const [specifier, target] of aliases) {
          api.onResolve(
            { filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) },
            () => ({ path: target }),
          );
        }
      },
    },
  ],
});
