import { assertEquals } from "@std/assert";
import {
  generateReleaseNotesModule,
  readReleaseNotesDir,
} from "../../../scripts/release-notes-bundle.mjs";

// #93: scripts/plugin-build.mjs bundles docs/releases/X.Y.Z.md deterministically.

Deno.test("release-notes-bundle - reads only X.Y.Z.md sorted newest-first with normalized LF", async () => {
  const dir = await Deno.makeTempDir({ prefix: "geode-release-notes-" });
  try {
    await Deno.writeTextFile(`${dir}/1.0.0.md`, "First release.\r\n");
    await Deno.writeTextFile(`${dir}/1.0.10.md`, "## 1.0.10\r\n- Big item.\r\n");
    await Deno.writeTextFile(`${dir}/1.0.2.md`, "## 1.0.2\n- Small item.\n");
    await Deno.writeTextFile(`${dir}/1.0.3-beta.1.md`, "Beta ignored.\n");
    await Deno.writeTextFile(`${dir}/README.md`, "Index ignored.\n");

    const entries = await readReleaseNotesDir(dir);
    assertEquals(entries, [
      { version: "1.0.10", body: "## 1.0.10\n- Big item." },
      { version: "1.0.2", body: "## 1.0.2\n- Small item." },
      { version: "1.0.0", body: "First release." },
    ]);
    // Reproducible: repeated generation produces identical bytes.
    assertEquals(generateReleaseNotesModule(entries), generateReleaseNotesModule(entries));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("release-notes-bundle - missing directory produces an empty array", async () => {
  const entries = await readReleaseNotesDir("/tmp/geode-nonexistent-release-notes-dir-93");
  assertEquals(entries, []);
  const src = generateReleaseNotesModule(entries);
  assertEquals(src.includes("RELEASE_NOTES: readonly BundledReleaseNote[] = []"), true);
});
