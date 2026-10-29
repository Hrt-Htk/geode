import { assert } from "@std/assert";
import { pair, restartPlugin, waitFor } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

/**
 * Issue #192: conflict is a valid outcome after restart + replay.
 *
 * When B has an untracked local edit (direct disk write bypassing events),
 * then restarts with fresh state and replays the server version, the
 * reconciler should detect the divergence.  A conflict file is the correct
 * outcome: it preserves both the local edit and the server version.
 *
 * The E2E test `data-loss-revert-on-restart.hybrid.spec.ts` times out in
 * Phase 4 because it waits only for "synced", but "conflict" is equally valid.
 */
Deno.test({
  name: "restart-replay-conflict-valid: untracked local edit produces conflict after restart",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const p = await pair();
    let B: Awaited<ReturnType<typeof pair>>["B"] | undefined;
    try {
      const path = "notes/doc.md";

      // A creates, B receives
      p.A.fakeVault.write(path, "line1\nline2\nline3\n");
      await p.A.flushPending();
      await p.B.waitForVersion(path);

      // B makes an untracked local edit (bypassing events: like lockVault + direct write)
      p.B.fakeVault.files.set(path, new TextEncoder().encode("line1\nLOCAL EDIT\nline3\n"));
      // A real disk edit moves the mtime; without it the startup scan skips the file as unchanged.
      p.B.fakeVault.mtimes.set(path, Date.now() + 5_000);

      // A pushes a divergent edit
      p.A.fakeVault.write(path, "line1\nSERVER EDIT\nline3\n");
      await p.A.flushPending(); // A's edit is committed to the server; B's restart will replay it

      // B restarts with fresh state: server replays A's version
      B = await restartPlugin(p.B, p.server);
      await waitFor(
        () =>
          B.syncManager.getConflictCount() > 0 ||
          [...B.fakeVault.files.keys()].some((k) => isConflictPath(k)),
        "conflict to appear after restart + replay",
        20_000,
      );

      const conflictCount = B.syncManager.getConflictCount();
      const conflictFiles = [...B.fakeVault.files.keys()].filter((k) => isConflictPath(k));

      assert(
        conflictCount > 0 || conflictFiles.length > 0,
        `Expected conflict after restart+replay with divergent local edit. ` +
          `Conflict count: ${conflictCount}, files: ${conflictFiles.join(", ")}. ` +
          `Silent overwrite = data loss.`,
      );

      // B's local edit must be preserved somewhere
      const allContent = [...B.fakeVault.files.entries()]
        .map(([, d]) => new TextDecoder().decode(d)).join("\n");
      assert(
        allContent.includes("LOCAL EDIT"),
        `B's local edit must be preserved. All content:\n${allContent}`,
      );
    } finally {
      try {
        B?.stop();
      } catch { /* teardown is best-effort */ }
      await p.stop();
    }
  },
});
