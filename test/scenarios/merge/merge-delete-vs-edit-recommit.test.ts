import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// Regression for #361: the server deleted a file this device edited offline. The
// merge must RE-COMMIT the local edit onto the tombstone parent, not just record
// local state and defer the commit to a "next sync cycle" that never comes: the
// reconciler sees disk hash == state hash and emits nothing, so the file stays
// orphaned on this device and peers never get it back.
Deno.test({
  name: "merge-delete-vs-edit-recommit - server-deleted local edit comes back on peers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      // Create base file from A, both sync it.
      A.fakeVault.write("doc.md", "original content");
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // B goes offline and edits the file.
      B.disconnect();
      const bContent = "B edited the file offline";
      B.fakeVault.write("doc.md", bContent);
      B.markLocalEdit("doc.md");

      // A deletes the file and syncs → server tombstone.
      A.fakeVault.delete("doc.md");
      await A.flushPending();

      // B reconnects: the tombstone conflicts with B's local edit → merge.
      await B.reconnect();

      // Both disks must converge on B's content.
      await A.waitForConvergence(B, "doc.md");
      const aFinal = new TextDecoder().decode(await A.fakeVault.readBinary("doc.md"));
      assertEquals(aFinal, bContent, "A gets B's edit back");

      // Server head for the file must be live, not deleted.
      const pathHash = A.state.getLocalFile("doc.md")!.path_hash;
      const head = server.db
        .prepare(
          "SELECT deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
        )
        .get(vaultId, pathHash) as { deleted: number } | null;
      assertEquals(head?.deleted, 0, "server head for doc.md is live");
    } finally {
      await stop();
    }
  },
});
