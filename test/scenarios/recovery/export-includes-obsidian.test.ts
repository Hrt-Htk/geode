import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name:
    "export-includes-obsidian - exportDecryptedVault writes ALL synced files including .obsidian/",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const exportDir = Deno.makeTempDirSync();
    const { A, B, stop } = await pair();
    try {
      // .obsidian files only sync with the config toggle on (real isSyncable gating,
      // per device: both devices need it).
      for (const dev of [A, B]) {
        dev.settings.syncObsidianConfig = true;
        dev.settings.syncedPlugins = ["community"];
        dev.syncManager.setSyncObsidianConfig(true);
      }
      // Seed regular files and .obsidian config files
      A.fakeVault.write("docs/readme.md", "# readme");
      A.fakeVault.write("notes/todo.md", "- buy milk");
      A.fakeVault.write(".obsidian/app.json", '{"theme":"obsidian"}');
      A.fakeVault.write(".obsidian/plugins/community/data.json", '{"k":"v"}');
      A.fakeVault.write(".obsidian/core-plugins.json", '["backlink","graph"]');
      await A.flushPending();

      // Wait for B to receive all files
      await B.waitForVersion("docs/readme.md", 1);
      await B.waitForVersion("notes/todo.md", 1);
      await B.waitForVersion(".obsidian/app.json", 1);
      await B.waitForVersion(".obsidian/plugins/community/data.json", 1);
      await B.waitForVersion(".obsidian/core-plugins.json", 1);

      // Export from A
      const result = await A.exportDecryptedVault(exportDir);
      const exportedFiles = await listFiles(exportDir);

      // exportDecryptedVault writes ALL non-deleted server heads: including .obsidian/
      // This documents the real behavior that the E2E test's EXPORT_PATHS doesn't account for.
      assertEquals(
        result.exportedFiles,
        A.fakeVault.files.size,
        "exportedFiles should equal total vault files (including .obsidian/)",
      );
      assertEquals(
        exportedFiles.length,
        A.fakeVault.files.size,
        "exported file tree should match total vault files",
      );

      // Assert .obsidian paths are present in the export
      const obsidianExports = exportedFiles.filter((p) => p.includes(".obsidian"));
      assertEquals(
        obsidianExports.length,
        3,
        ".obsidian/ config files should be present in the export",
      );

      // Verify content round-trips correctly for a .obsidian file
      const appJsonPath = `${exportDir}/.obsidian/app.json`;
      const exportedAppJson = await Deno.readTextFile(appJsonPath);
      assertEquals(exportedAppJson, '{"theme":"obsidian"}');
    } finally {
      await stop();
      Deno.removeSync(exportDir, { recursive: true });
    }
  },
});

async function listFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const fullPath = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      results.push(...await listFiles(fullPath));
    } else if (entry.isFile) {
      results.push(fullPath);
    }
  }
  return results;
}
