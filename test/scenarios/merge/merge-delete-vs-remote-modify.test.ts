import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// Regression for #110: a committed delete that the server reports as a conflict
// (delete/modify) must not crash the reconciler. Before the fix, handleConflict
// unconditionally read the: already deleted: local file (readBinary → ENOENT),
// producing an unhandled rejection off the async reconciler that wedged sync.
Deno.test({
  name:
    "merge-delete-vs-remote-modify - A deletes stale file, B modified it → no crash, no markers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create base file from A, both sync it.
      A.fakeVault.write("doc.md", "line 1\nline 2\nline 3\n");
      await A.flushPending();
      await B.waitForVersion("doc.md");

      // A disconnects: it will keep a stale last_seen_version.
      A.disconnect();

      // B modifies the file → server head advances past A's last_seen_version.
      B.fakeVault.write("doc.md", "line 1\nline 2 modified by B\nline 3\n");
      B.markLocalEdit("doc.md");
      await B.flushPending();

      // A deletes its (now stale) local copy while offline, then reconnects.
      // The delete commit hits a conflict (parent_version is behind the head),
      // and the local file is already gone on disk.
      A.fakeVault.delete("doc.md");
      await A.reconnect();

      // The reconciler notices doc.md is gone from disk and emits a delete op.
      // commitDelete hits a conflict (stale parent), and handleConflict then reads
      // the already-deleted local file. Before the fix this throws
      // "file not found: doc.md" out of handleConflict.
      await A.reconcileNow();
      await sleep(1500);

      // The delete/modify conflict must resolve sanely without crashing.
      // No merge markers may be written to the primary file.
      if (A.fakeVault.fileExists("doc.md")) {
        const aFinal = new TextDecoder().decode(await A.fakeVault.readBinary("doc.md"));
        assert(!aFinal.includes("<<<<<<<"), "no merge markers in primary file");
        assert(!aFinal.includes(">>>>>>>"), "no merge markers in primary file");
      }

      // Any surfaced conflict file must not carry markers into the primary path either.
      const primaryHasMarkers = [...A.fakeVault.files.entries()].some(([p, data]) => {
        if (p.startsWith("doc (conflict ")) return false;
        return new TextDecoder().decode(data).includes("<<<<<<<");
      });
      assertEquals(primaryHasMarkers, false, "no merge markers on any primary file");
    } finally {
      await stop();
    }
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
