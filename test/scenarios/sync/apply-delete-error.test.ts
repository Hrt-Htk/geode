import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// Regression for #367: applyDelete swallowed EVERY removal error as "already
// deleted" and marked state deleted: if the file still exists the reconciler
// re-creates it (resurrection). Only NotFound (file already gone) is benign; any
// other error must not mark the state deleted.
Deno.test({
  name: "apply-delete - non-NotFound delete error does not mark state deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "gone.md";
      A.fakeVault.write(path, "content");
      await A.flushPending();
      await B.waitForVersion(path);

      // Make B's delete throw a non-NotFound error for this path.
      const origDelete = B.fakeVault.delete.bind(B.fakeVault);
      B.fakeVault.delete = (p) => {
        const pp = typeof p === "string" ? p : p.path;
        if (pp === path) throw new Error("disk full");
        return origDelete(p);
      };

      // A deletes the file and commits → B receives a delete version.
      A.fakeVault.delete(path);
      await A.flushPending();
      await sleep(1500);

      // The delete failed on B: state must NOT be marked deleted and the file
      // must still be present (no resurrection).
      const row = B.state.getLocalFile(path);
      assertEquals(row?.deleted, false, "delete failure must not mark state deleted");
      assertEquals(B.fakeVault.fileExists(path), true, "file still present on disk");
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
