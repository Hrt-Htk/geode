import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "initial-sync - A creates 5 files then B joins and converges",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
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
        const bContent = new TextDecoder().decode(await B.fakeVault.readBinary(path));
        assertEquals(bContent, content, `B's ${path} content mismatch`);
      }
    } finally {
      await stop();
    }
  },
});
