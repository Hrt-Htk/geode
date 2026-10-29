import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair, type TestPlugin, waitFor } from "../../two-vault-driver.ts";

const TOKEN = "LOCAL EDIT";

/** The path's op is still inside the 2 s debounce window: it never reached the
 * commit queue, so only the apply-side debounce probe can see it. */
function assertEditInDebounceWindow(device: TestPlugin, path: string): void {
  assertEquals(
    device.eventHandler!.getPendingOps().filter((op) => op.path === path && op.kind === "commit")
      .length,
    1,
    "premise: the edit must still be pending in the event debounce when the close applies",
  );
}

function maxServerSeq(db: Database, vaultId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?").get(
    vaultId,
  ) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function vaultText(device: TestPlugin): string {
  return [...device.fakeVault.files.values()].map((b) => new TextDecoder().decode(b)).join("\n");
}

/**
 * Issue #589 (S1, `rename-no-edit-lost`): an edit made inside the 2 s debounce
 * window is silently lost when a remote delete of the same file arrives in that
 * window: `hasLocalEdits` only sees the commit queue and promoted paths, so the
 * delete applies, removes the file, and the flush's commit then finds nothing
 * to upload. The edit must survive (local-wins re-commit here, per #361).
 */
Deno.test({
  name: "debounce vs remote delete - the edit survives",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/doc.md";
      A.fakeVault.write(path, "line1\nline2\n");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // B edits, then goes dark: the op stays in the debounce while A's delete lands.
      B.fakeVault.write(path, `line1\n${TOKEN}\nline2\n`);
      B.pause();
      A.fakeVault.delete(path);
      await A.flushPending();
      const deletedSeq = maxServerSeq(server.db, vaultId);

      await B.resume();
      await B.waitForCaughtUp(deletedSeq);
      assertEditInDebounceWindow(B, path);

      // The window fires, the flush commits, both devices settle.
      await B.pushNow();
      await waitFor(() => vaultText(A).includes(TOKEN), "the edit to reach A", 10_000);
      await waitFor(() => vaultText(B).includes(TOKEN), "the edit to stay on B", 10_000);

      assertEquals(A.fakeVault.fileExists(path), true, "the edit comes back at its own name");
      assertEquals(
        new TextDecoder().decode(A.fakeVault.files.get(path)),
        `line1\n${TOKEN}\nline2\n`,
        "A holds the edited body",
      );
    } finally {
      await stop();
    }
  },
});

/**
 * The same window against a remote rename: the marker must carry the pending edit
 * to the new name (#583 decision 2) instead of closing the old name and leaving
 * the flush to commit nothing.
 */
Deno.test({
  name: "debounce vs remote rename - the edit follows the name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const from = "dir-a/note.md";
      const to = "dir-b/note.md";
      A.fakeVault.write(from, "line1\nline2\n");
      await A.flushPending();
      await B.waitForVersion(from, 1);

      B.fakeVault.write(from, `line1\n${TOKEN}\nline2\n`);
      B.pause();
      A.fakeVault.rename(from, to);
      await A.flushPending();
      const renamedSeq = maxServerSeq(server.db, vaultId);

      await B.resume();
      await B.waitForCaughtUp(renamedSeq);
      assertEditInDebounceWindow(B, from);

      await B.pushNow();
      await waitFor(
        () => new TextDecoder().decode(A.fakeVault.files.get(to)).includes(TOKEN),
        "the edit to reach the new name on A",
        10_000,
      );
      await waitFor(
        () => new TextDecoder().decode(B.fakeVault.files.get(to)).includes(TOKEN),
        "the edit to reach the new name on B",
        10_000,
      );

      assertEquals(B.fakeVault.fileExists(from), false, "the old name is not resurrected on B");
      assertEquals(A.fakeVault.fileExists(from), false, "the old name is not resurrected on A");
    } finally {
      await stop();
    }
  },
});

/**
 * A commit whose file is gone with the state row still live lost its edit outright
 * (nothing carried it, nothing deleted it). It must be counted as dropped: the
 * status icon and the last-backup stamp depend on that count: never disappear
 * behind a log line.
 */
Deno.test({
  name: "commit vanish - an unaccounted missing file is counted as dropped",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "notes/gone.md";
      A.fakeVault.write(path, "body\n");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // The bytes go without an event (no delete op) and without closing the row.
      A.fakeVault.files.delete(path);
      await A.commitDirect(path);

      assertEquals(A.syncManager.getDroppedCount(), 1, "the lost edit is counted as dropped");
      assertEquals(A.syncManager.getPendingOps().length, 0, "the op does not linger for retries");
    } finally {
      await stop();
    }
  },
});
