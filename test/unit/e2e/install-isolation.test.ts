import { assertEquals } from "@std/assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installPlugin } from "../../../test/e2e/fixtures/install.ts";

// Installing the plugin and then writing per-test settings into the installed dir must NEVER
// modify the shared plugin source dir (plugin-dist), which a dev vault may be symlinked to.
Deno.test("installPlugin isolates per-vault writes from the plugin source dir", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "geode-src-"));
  const vault = await mkdtemp(path.join(tmpdir(), "geode-vault-"));
  const dest = path.join(vault, ".obsidian", "plugins", "geode");
  try {
    await writeFile(path.join(src, "main.js"), "BUILD_OUTPUT");
    await writeFile(path.join(src, "data.json"), JSON.stringify({ marker: "REAL_USER_SETTINGS" }));

    await mkdir(path.dirname(dest), { recursive: true });
    await installPlugin(src, dest);

    // The fixture writes the test vault's own data.json into the installed plugin dir.
    await writeFile(path.join(dest, "data.json"), JSON.stringify({ marker: "TEST_SETTINGS" }));

    // The source dir's data.json MUST be untouched.
    const srcData = JSON.parse(await readFile(path.join(src, "data.json"), "utf8"));
    assertEquals(srcData.marker, "REAL_USER_SETTINGS");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});
