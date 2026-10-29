import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

/**
 * Regression test for #384: a file deleted and then re-created with IDENTICAL
 * content must re-sync. The reconciler's mtime-drift branch matched a tombstoned
 * state row (deleted: true), bumping only the mtime and never clearing `deleted`,
 * so the re-creation never committed and the file stayed deleted everywhere else.
 *
 * This exercises the RECONCILER path: the re-creation is written straight to disk
 * (no vault event), so the event handler never sees it and the reconciler's
 * mtime-drift branch is what must pick it up. The plain vault-event path (a
 * `create` event) already works via commit.ts's `!local.deleted` guard (#366).
 */
Deno.test({
  name: "recreate-identical - re-created identical file re-syncs after delete (reconciler path)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "note.md";
      const content = "hello world\n";

      // 1. A writes F, B syncs it.
      A.fakeVault.write(path, content);
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // 2. A deletes F and syncs, so B loses F; A's row is tombstoned.
      const originalMtime = A.fakeVault.mtimes.get(path)!;
      A.fakeVault.delete(path);
      await A.flushPending();
      await B.waitForDeleted(path);
      assertEquals(
        A.state.getLocalFile(path)!.deleted,
        true,
        "A's F should be tombstoned after delete",
      );

      // 3. A re-creates F with the SAME bytes, written directly to disk (no
      //    vault event) with a bumped mtime, then runs the reconciler.
      const bytes = new TextEncoder().encode(content);
      A.fakeVault.files.set(path, new Uint8Array(bytes));
      A.fakeVault.mtimes.set(path, originalMtime + 1_000);
      await A.reconcileNow();

      // 4. F must come back on B, and the server head for F must be live.
      await B.waitForVersion(path, 2);
      assertEquals(
        new TextDecoder().decode(B.fakeVault.files.get(path)!),
        content,
        "F should be re-created on B",
      );

      const pathHash = A.state.getLocalFile(path)!.path_hash;
      const head = server.db
        .prepare(
          "SELECT deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
        )
        .get(vaultId, pathHash) as { deleted: number };
      assertEquals(head.deleted, 0, "server head for F should be live (deleted = 0)");
    } finally {
      await stop();
    }
  },
});
