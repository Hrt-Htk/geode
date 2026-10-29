import type { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { pair, type TestPlugin, waitFor } from "../../two-vault-driver.ts";

const TOKEN = "REMOTE EDIT";

function maxServerSeq(db: Database, vaultId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM file_versions WHERE vault_id = ?").get(
    vaultId,
  ) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function headRow(
  db: Database,
  vaultId: string,
  pathHash: string,
): { version: number; deleted: number } | undefined {
  return db
    .prepare(
      "SELECT version, deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
    )
    .get(vaultId, pathHash) as { version: number; deleted: number } | undefined;
}

function pathHashOf(device: TestPlugin, path: string): string {
  const row = device.state.getLocalFile(path);
  assertEquals(row !== null, true, `premise: ${path} has a local state row`);
  return row!.path_hash;
}

/** The path's delete is still inside the 2 s debounce window (never reached the commit
 * queue), so only the event layer knows about it: the premise of #593. */
function assertDeleteInDebounceWindow(device: TestPlugin, path: string): void {
  assertEquals(
    device.eventHandler!.getPendingOps().filter((op) => op.path === path && op.kind === "delete")
      .length,
    1,
    "premise: the delete must still be pending in the event debounce when the version applies",
  );
}

/** #593: the winning edit drops the delete op itself, whichever layer still held it:
 * left in place it is what sends the tombstone over the restored version. */
function assertNoDeletePending(device: TestPlugin, path: string): void {
  const deletes = (ops: Array<{ path: string; kind: string }>) =>
    ops.filter((op) => op.path === path && op.kind === "delete").length;
  assertEquals(deletes(device.eventHandler!.getPendingOps()), 0, "gone from the debounce");
  assertEquals(deletes(device.syncManager.getPendingOps()), 0, "gone from the commit queue");
}

/**
 * Issue #593: a local delete inside the 2 s debounce window is invisible to the apply
 * path (the file is gone, so there is no disk hash to diverge): a remote *edit* of the
 * same file re-writes it and the queued delete is then cancelled by the "file is back"
 * guard, silently undoing the user's delete. Per #361 the remote edit is kept, but the
 * override must be visible (an activity row), never a silent resurrection.
 */
Deno.test({
  name: "debounce delete vs remote edit - the edit is kept and the override is visible",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/doc.md";
      A.fakeVault.write(path, "line1\nline2\n");
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // B deletes inside the window, then goes dark so the op stays in the debounce
      // while A's edit lands on the server.
      B.pause();
      B.fakeVault.delete(path);
      A.fakeVault.write(path, `line1\n${TOKEN}\nline2\n`);
      await A.flushPending();
      const editSeq = maxServerSeq(server.db, vaultId);
      assertDeleteInDebounceWindow(B, path);

      await B.resume();
      await B.waitForCaughtUp(editSeq);
      assertNoDeletePending(B, path);

      assertEquals(B.fakeVault.fileExists(path), true, "the edit comes back at its own name");
      assertEquals(
        new TextDecoder().decode(B.fakeVault.files.get(path)),
        `line1\n${TOKEN}\nline2\n`,
        "B holds A's edited body",
      );
      assertEquals(
        B.activity.entries.get(path)?.kind,
        "restored",
        "the delete being overridden by a remote edit is visible in the activity log",
      );

      // The queued delete is accounted for, not left pending forever.
      await B.pushNow();
      assertEquals(B.syncManager.getPendingOps().length, 0, "the cancelled delete does not linger");
      assertEquals(
        B.syncManager.getDroppedCount(),
        0,
        "nothing was dropped behind the user's back",
      );
      assertEquals(B.fakeVault.fileExists(path), true, "B still holds the edit after the flush");
      assertEquals(
        headRow(server.db, vaultId, pathHashOf(B, path))?.deleted,
        0,
        "A's edit stays the server head",
      );
    } finally {
      await stop();
    }
  },
});

/**
 * The same window against a version that carries exactly the content the user deleted:
 * nothing new would be lost by letting the delete stick, so it does: on the server too
 * (the queued op tombstones the head instead of being cancelled).
 */
Deno.test({
  name: "debounce delete vs an identical version - the delete sticks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      const path = "notes/doc.md";
      const body = "line1\nline2\n";
      A.fakeVault.write(path, body);
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // A's device closes and re-creates the note with the same bytes: a new version
      // carrying exactly what B is about to delete.
      B.pause();
      A.fakeVault.delete(path);
      await A.flushPending();
      A.fakeVault.write(path, body);
      await A.flushPending();
      const recreatedSeq = maxServerSeq(server.db, vaultId);

      // B deletes right before reconnecting, so its op is still in the debounce while
      // the replayed versions land.
      B.fakeVault.delete(path);
      assertDeleteInDebounceWindow(B, path);
      await B.resume();
      await B.waitForCaughtUp(recreatedSeq);

      assertEquals(
        B.fakeVault.fileExists(path),
        false,
        "an identical version does not resurrect it",
      );
      assertEquals(
        B.activity.entries.get(path)?.kind === "restored",
        false,
        "no restore is recorded for a version that adds nothing",
      );

      // The delete op tombstones the re-created head, so the delete is the one that
      // sticks everywhere instead of being cancelled by the "file is back" guard.
      await B.pushNow();
      await waitFor(
        () => headRow(server.db, vaultId, pathHashOf(B, path))?.deleted === 1,
        "the delete to reach the server",
        10_000,
      );
      await waitFor(() => !A.fakeVault.fileExists(path), "A to apply the delete", 10_000);
      assertEquals(B.fakeVault.fileExists(path), false, "B keeps it deleted");
      assertEquals(
        B.activity.entries.get(path)?.kind,
        "delete",
        "the delete that stuck is what the activity log shows",
      );
    } finally {
      await stop();
    }
  },
});

/**
 * #593: the same window on a `.obsidian/` config file (config sync on). Those paths are
 * written through the adapter fallback and are NOT in the vault index, so commit.ts's
 * "a restored head put the file back, the queued delete is stale" guard (#498) cannot
 * see them, unless the winning edit cancels the delete itself, its tombstone lands at
 * the restored version's parent, the peer deletes the file, and this device re-uploads
 * it: a flap.
 */
Deno.test({
  name: "debounce delete vs remote edit - an unindexed config path sends no tombstone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.settings.syncObsidianConfig = true;
      B.settings.syncObsidianConfig = true;
      const path = ".obsidian/app.json";
      A.fakeVault.write(path, '{"seed":1}');
      await A.flushPending();
      await B.waitForVersion(path, 1);
      assertEquals(B.fakeVault.getAbstractFileByPath(path), null, "premise: not in the index");

      B.pause();
      B.fakeVault.delete(path);
      A.fakeVault.write(path, '{"seed":1,"edit":true}');
      await A.flushPending();
      const editSeq = maxServerSeq(server.db, vaultId);
      assertDeleteInDebounceWindow(B, path);

      await B.resume();
      await B.waitForCaughtUp(editSeq);
      assertNoDeletePending(B, path);
      assertEquals(B.fakeVault.fileExists(path), true, "the edit comes back");
      assertEquals(
        B.activity.entries.get(path)?.kind,
        "restored",
        "the delete being overridden by a remote edit is visible",
      );

      const headBefore = headRow(server.db, vaultId, pathHashOf(B, path));
      await B.pushNow();
      assertEquals(B.syncManager.getPendingOps().length, 0, "the cancelled delete does not linger");
      assertEquals(
        headRow(server.db, vaultId, pathHashOf(B, path)),
        headBefore,
        "no tombstone (and no re-upload) follows the restored edit",
      );
      assertEquals(B.fakeVault.fileExists(path), true, "B keeps the edit");
    } finally {
      await stop();
    }
  },
});

/**
 * #593: the queued leg: the delete already left the debounce and sits in the commit
 * queue (gated here, as a re-key does) when the remote edit applies. The #498 guard
 * cannot cancel an unindexed path, so the queued op itself must be dropped: otherwise
 * it drains as a tombstone on top of the restored edit.
 */
Deno.test({
  name: "queued delete vs remote edit - an unindexed config path's delete is cancelled",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.settings.syncObsidianConfig = true;
      B.settings.syncObsidianConfig = true;
      const path = ".obsidian/app.json";
      A.fakeVault.write(path, '{"seed":1}');
      await A.flushPending();
      await B.waitForVersion(path, 1);

      // Gate B's commit queue (the transport stays live) so the delete drains out of the
      // debounce into the queue while A's edit lands and applies.
      B.syncManager.pause();
      B.fakeVault.delete(path);
      await waitFor(
        () => B.syncManager.getPendingOps().length === 1,
        "the delete to reach the gated commit queue",
        10_000,
      );
      assertEquals(B.eventHandler!.getPendingOps().length, 0, "premise: it left the debounce");

      A.fakeVault.write(path, '{"seed":1,"edit":true}');
      await A.flushPending();
      const editSeq = maxServerSeq(server.db, vaultId);
      await B.waitForCaughtUp(editSeq);
      assertNoDeletePending(B, path);
      assertEquals(B.fakeVault.fileExists(path), true, "the edit comes back");
      assertEquals(
        B.activity.entries.get(path)?.kind,
        "restored",
        "the delete being overridden by a remote edit is visible",
      );

      const headBefore = headRow(server.db, vaultId, pathHashOf(B, path));
      await B.resume();
      await B.waitForIdle();
      assertEquals(B.syncManager.getPendingOps().length, 0, "the queued delete is gone, not held");
      assertEquals(
        headRow(server.db, vaultId, pathHashOf(B, path)),
        headBefore,
        "no tombstone (and no re-upload) follows the restored edit",
      );
      assertEquals(B.fakeVault.fileExists(path), true, "B keeps the edit");
    } finally {
      await stop();
    }
  },
});
