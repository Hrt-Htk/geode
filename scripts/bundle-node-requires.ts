import { builtinModules } from "node:module";

// A load-time require is a top-level assignment from a `require()` call: esbuild emits
// `var import_x = require("y");` (or `__toESM(require("y"))`) at column 0 for what the
// source imported statically, and the same call indented inside a function for a dynamic
// import, which only runs when the code reaches it.
const LOAD_TIME_REQUIRE = /^(?:var|let|const) [\w$]+ = (?:__toESM\()?require\(["']([^"']+)["']\)/;

const NODE_MODULES = new Set(builtinModules);

/** The lines of a plugin bundle that require a Node module while the bundle loads. Node's
 * modules do not exist on mobile, so anything but an empty list means the build cannot ship. */
export function findLoadTimeNodeRequires(source: string): string[] {
  return source.split("\n").filter((line) => {
    const specifier = LOAD_TIME_REQUIRE.exec(line)?.[1];
    return specifier !== undefined && NODE_MODULES.has(specifier.replace(/^node:/, ""));
  });
}
