import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

// #549: a file with no local-files.json row (lost on a kill inside the persist
// window) whose server head was NOT committed by this device: the merger must
// fall back to this device's newest version in the server chain as the 3-way
// merge base, so non-overlapping edits merge cleanly instead of becoming a
// conflict file.
Deno.test({
  name: "merge-lost-row-own-base - no local row, own version further back → clean 3-way merge",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "doc.md";

      // v1: A commits the base.
      A.fakeVault.write(path, "a\nb\nc\n");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // v2: B edits line 2 (remote change on top of A's base).
      B.fakeVault.write(path, "a\nb2\nc\n");
      await B.flushPending();
      await A.waitForVersion(path, 2);

      // A goes offline, edits line 1 (written straight to the files map so no
      // event-triggered commit is queued), then loses its state row (kill
      // inside the persist window): the file stays on disk with the edit.
      A.pause();
      A.fakeVault.files.set(path, new TextEncoder().encode("a2\nb2\nc\n"));
      A.fakeVault.mtimes.set(path, Date.now());
      const row = A.state.getLocalFile(path)!;
      (
        A.state as unknown as { localFiles: Map<string, unknown> }
      ).localFiles.delete(path);
      (
        A.state as unknown as { localFilesByHash: Map<string, unknown> }
      ).localFilesByHash.delete(row.path_hash);
      A.markLocalEdit(path);

      // v3: B edits line 3. A reconnects, replays v3, and its apply routes
      // through the conflict handler with localVersion === null.
      B.fakeVault.write(path, "a\nb2\nc3\n");
      await B.flushPending();
      await A.resume();

      const start = Date.now();
      while (Date.now() - start < 15_000) {
        const aRow = A.state.getLocalFile(path);
        if (aRow && aRow.last_seen_version >= 4) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // A merged both edits over its own v1 base: no conflict file.
      const aDisk = new TextDecoder().decode(await A.fakeVault.readBinary(path));
      assertEquals(aDisk, "a2\nb2\nc3\n", "A disk holds the 3-way merge");
      const aConflicts = [...A.fakeVault.files.keys()].filter((p) => isConflictPath(p));
      assertEquals(aConflicts, [], "no conflict file on A");
      assertEquals(
        A.state.getLocalFile(path)!.last_seen_version,
        4,
        "A state advanced to the merged version (merge commit on top of v3)",
      );

      // B converges to the same content.
      await A.waitForConvergence(B, path);
      const bDisk = new TextDecoder().decode(await B.fakeVault.readBinary(path));
      assertEquals(bDisk, "a2\nb2\nc3\n", "B disk holds the merged content");
    } finally {
      await stop();
    }
  },
});
