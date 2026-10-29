import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

// Regression for #367: on merge-retry exhaustion the conflict fallback used to
// write the LOCAL body into the conflict file, keep local on disk and bump
// last_seen_version, so the server copy survived nowhere on this device and the
// next reconcile re-committed local over the server head. The fallback must
// mirror orchestrateMerge's conflict_file branch: path gets the SERVER content,
// the conflict file gets the LOCAL content, state records the server version.
Deno.test({
  name: "retry-exhausted - conflict fallback keeps server content on disk, local in conflict file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    try {
      const path = "notes/retry.md";

      // Step 1: base content on both devices.
      p.A.fakeVault.write(path, "base\n");
      await p.A.flushPending();
      await p.B.waitForVersion(path, 1);

      // Step 2: B edits and commits -> server version 2 (a server copy).
      p.B.fakeVault.write(path, "server-content\n");
      await p.B.flushPending();
      await p.A.waitForVersion(path, 2);

      // Step 3: A makes an (uncommitted, offline) local edit that diverges from
      // the server. Write straight to the files map to avoid an event-triggered
      // commit, then mark it tracked so hasLocalEdits() is true.
      p.A.fakeVault.files.set(path, new TextEncoder().encode("local-content\n"));
      p.A.markLocalEdit(path);

      // Step 4: pre-set the retry counter to the cap so the NEXT conflict call
      // (triggered by B's new version below) takes the exhausted branch.
      const sm = p.A.syncManager as unknown as {
        conflictHandler: { conflictRetries: Map<string, number> };
      };
      sm.conflictHandler.conflictRetries.set(path, 5); // MAX_RETRIES is 5

      // Step 5: B pushes a newer version while A holds the local edit -> A's
      // apply sees a local edit -> onConflict -> handleConflict hits the cap.
      p.B.fakeVault.write(path, "server-content-2\n");
      await p.B.flushPending();

      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const row = p.A.state.getLocalFile(path);
        if (row && row.last_seen_version >= 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Step 6: the path must keep the SERVER copy, never local.
      assertEquals(
        new TextDecoder().decode(await p.A.fakeVault.readBinary(path)),
        "server-content-2\n",
        "path keeps the server copy",
      );

      // Step 7: the LOCAL copy is preserved in the conflict file.
      const conflictPath = [...p.A.fakeVault.files.keys()].find((k) => isConflictPath(k));
      assertEquals(Boolean(conflictPath), true, "conflict file created");
      assertEquals(
        new TextDecoder().decode(await p.A.fakeVault.readBinary(conflictPath!)),
        "local-content\n",
        "conflict file holds the local copy",
      );

      // Step 8: state records the server version, not the local edit.
      const after = p.A.state.getLocalFile(path)!;
      assertEquals(after.last_seen_version, 3, "state advanced to the server version");
    } finally {
      await p.stop();
    }
  },
});
