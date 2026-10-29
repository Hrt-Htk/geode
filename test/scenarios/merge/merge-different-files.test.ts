import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

Deno.test({
  name: "merge-different-files - concurrent edits to different files both commit cleanly",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("alpha.md", "alpha base");
      A.fakeVault.write("beta.md", "beta base");
      await A.flushPending();
      await B.waitForVersion("alpha.md", 1);
      await B.waitForVersion("beta.md", 1);

      B.disconnect();

      A.fakeVault.write("alpha.md", "alpha from A");
      await A.flushPending();

      B.fakeVault.write("beta.md", "beta from B");
      await B.reconnect();
      await B.commitDirect("beta.md");

      await B.waitForVersion("alpha.md", 2);
      await A.waitForVersion("beta.md", 2);

      assertEquals(
        new TextDecoder().decode(await A.fakeVault.readBinary("alpha.md")),
        "alpha from A",
      );
      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary("alpha.md")),
        "alpha from A",
      );
      assertEquals(
        new TextDecoder().decode(await A.fakeVault.readBinary("beta.md")),
        "beta from B",
      );
      assertEquals(
        new TextDecoder().decode(await B.fakeVault.readBinary("beta.md")),
        "beta from B",
      );
      assertEquals(listConflictFiles(A.fakeVault.files.keys()).length, 0);
      assertEquals(listConflictFiles(B.fakeVault.files.keys()).length, 0);
    } finally {
      await stop();
    }
  },
});

function listConflictFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((path) => isConflictPath(path));
}
