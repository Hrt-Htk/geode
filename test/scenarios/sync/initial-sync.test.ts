import { assert, assertEquals } from "@std/assert";
import { pair, pathVersionCount } from "../../two-vault-driver.ts";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test({
  name: "initial-sync - A creates 5 files, B joins and converges, then live updates land once each",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      // A creates 5 files
      const files: [string, string][] = [
        ["file1.md", "content one"],
        ["file2.md", "content two"],
        ["file3.md", "content three"],
        ["file4.md", "content four"],
        ["file5.md", "content five"],
      ];

      for (const [path, content] of files) {
        A.fakeVault.write(path, content);
      }
      await A.flushPending();

      // B should receive all 5 files
      for (const [path, content] of files) {
        await B.waitForVersion(path);
        assertEquals(decode(await B.fakeVault.readBinary(path)), content, `B's ${path} mismatch`);
      }

      // Live updates after the join: a create and a modify, each applied once.
      A.fakeVault.write("file6.md", "live create");
      A.fakeVault.write("file1.md", "live edit");
      await A.flushPending();

      await B.waitForVersion("file6.md");
      await B.waitForVersion("file1.md", 2);
      assertEquals(decode(await B.fakeVault.readBinary("file6.md")), "live create");
      assertEquals(decode(await B.fakeVault.readBinary("file1.md")), "live edit");

      // No duplicate version per path: one create, one edit.
      for (const [path, versions] of [["file6.md", 1], ["file1.md", 2]] as const) {
        const row = B.state!.getLocalFile(path);
        assert(row, `B holds no local row for ${path}`);
        assertEquals(
          pathVersionCount(server, vaultId, row.path_hash),
          versions,
          `${path} versions`,
        );
      }
    } finally {
      await stop();
    }
  },
});
