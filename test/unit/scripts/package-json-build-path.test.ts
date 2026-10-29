import { assertExists } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

/**
 * Verifies that the script paths referenced in package.json actually exist on disk.
 *
 * Regression test for issue #190: package.json had build:plugin and build:plugin:watch
 * pointing to `build\plugin-build.ts` instead of `scripts/plugin-build.ts`.
 */
Deno.test("package.json build scripts reference files that exist on disk", async () => {
  const pkgPath = new URL("package.json", REPO_ROOT);
  const pkgRaw = await Deno.readTextFile(pkgPath);
  const pkg = JSON.parse(pkgRaw);

  const scriptNames = ["build:plugin", "build:plugin:watch"];

  for (const name of scriptNames) {
    const script = pkg.scripts?.[name];
    assertExists(script, `package.json should have a "${name}" script`);

    // Extract the file path from the deno run command
    // Expected format: "deno run -A --node-modules-dir=auto <path>[ --watch]"
    const match = script.match(/deno\s+run\s+-A\s+--node-modules-dir=auto\s+(\S+)/);
    assertExists(match, `Could not extract script path from "${name}": ${script}`);

    const scriptPath = new URL(match[1], REPO_ROOT);
    const stat = await Deno.stat(scriptPath);
    assertExists(stat, `Script referenced by "${name}" does not exist: ${scriptPath.pathname}`);
  }
});
