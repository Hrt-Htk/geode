import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "export-vault - exported plaintext matches the live vault byte-for-byte",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const exportDir = Deno.makeTempDirSync();
    const { A, B, stop } = await pair();
    try {
      const binaryBytes = new Uint8Array([2, 4, 6, 8, 10]);

      A.fakeVault.write("docs/readme.md", "# readme");
      A.fakeVault.write("docs/nested/notes.txt", "hello export");
      A.fakeVault.writeBinary("assets/logo.png", binaryBytes);
      await A.flushPending();

      await B.waitForVersion("docs/readme.md", 1);
      await B.waitForVersion("docs/nested/notes.txt", 1);
      await B.waitForVersion("assets/logo.png", 1);

      const result = await A.exportDecryptedVault(exportDir);
      const exportedFiles = await listFiles(exportDir);

      assertEquals(result.exportedFiles, A.fakeVault.files.size);
      assertEquals(exportedFiles.length, A.fakeVault.files.size);

      for (const [vaultPath, bytes] of A.fakeVault.files) {
        const exportedPath = `${exportDir}/${vaultPath}`;
        const exportedBytes = await Deno.readFile(exportedPath);
        assertEquals([...exportedBytes], [...bytes], `export mismatch for ${vaultPath}`);
      }
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
