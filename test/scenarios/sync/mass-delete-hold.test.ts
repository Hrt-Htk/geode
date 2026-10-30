// #601 part 1: the sync engine behind "confirm a held mass delete": the guard holds the
// whole sync when a tracked set of files disappears while the app was closed, the hold is
// persisted (a restart stays offline instead of syncing the deletes), and one decision
// either restores the held paths from their server heads or confirms them into the trash.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  pair,
  restartPlugin,
  restartWithDiskChange,
  type TestPlugin,
  type TestServer,
  trashCount,
  versionCount,
  waitFor,
} from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";

const FOLDER = Array.from({ length: 20 }, (_, i) => `n/f${String(i).padStart(2, "0")}.md`);
const OTHERS = Array.from({ length: 10 }, (_, i) => `other/g${i}.md`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tree(plugin: TestPlugin): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

function content(plugin: TestPlugin, path: string): string {
  const bytes = plugin.fakeVault.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function pathVersionCount(server: TestServer, vaultId: string, pathHash: string): number {
  return (server.db.prepare(
    "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
  ).get(vaultId, pathHash) as { n: number }).n;
}

/** 20 notes in `n/` plus 10 elsewhere: deleting the folder is >= 20 files and 66%. */
async function seed(A: TestPlugin, B: TestPlugin): Promise<void> {
  for (const [i, path] of FOLDER.entries()) A.fakeVault.write(path, `note ${i}`);
  for (const [i, path] of OTHERS.entries()) A.fakeVault.write(path, `other ${i}`);
  await A.flushPending();
  await B.waitForVersion(FOLDER[FOLDER.length - 1]);
  await B.waitForVersion(OTHERS[OTHERS.length - 1]);
  assertEquals(tree(B), [...FOLDER, ...OTHERS].sort(), "precondition: both devices hold all 30");
}

/** Stop A, remove files from disk behind the app's back, start it again: the reconciler
 * reads 20 unpaired deletes over 25% and holds the whole sync. */
async function restartWithDeleted(
  A: TestPlugin,
  server: TestServer,
  removed: string[],
): Promise<TestPlugin> {
  const fresh = await restartWithDiskChange(A, server, () => {
    for (const path of removed) {
      A.fakeVault.files.delete(path);
      A.fakeVault.mtimes.delete(path);
    }
  });
  await waitFor(
    () => fresh.pluginSettings.massDeleteHold !== null,
    "the mass-delete guard to hold",
  );
  await waitFor(() => !fresh.isLive(), "the hold to close the transport");
  return fresh;
}

function assertConverged(A: TestPlugin, B: TestPlugin): void {
  assertEquals(tree(A), tree(B), "both vaults list the same files");
  for (const path of tree(A)) {
    assertEquals(
      new TextDecoder().decode(A.fakeVault.files.get(path)),
      new TextDecoder().decode(B.fakeVault.files.get(path)),
      `${path} converged`,
    );
  }
}

Deno.test({
  name:
    "mass-delete-hold - a folder deleted while closed holds on A only, and restoring all brings it back",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);

      const held = await restartWithDeleted(A, server, FOLDER);
      const hold = held.pluginSettings.massDeleteHold!;
      assertEquals(
        hold.files.map((f) => f.path).sort(),
        [...FOLDER].sort(),
        "the 20 missing notes",
      );
      assertEquals(hold.totalTracked, 30, "measured against the 30 tracked files");
      assert(hold.detectedAt > 0, "the hold records when it tripped");
      assert(hold.files.every((f) => f.mtime > 0), "each held path keeps its last known mtime");
      assertEquals(tree(held), [...OTHERS].sort(), "the held pass restored nothing on its own");
      assertEquals(tree(B), [...FOLDER, ...OTHERS].sort(), "B never heard about the deletes");

      // Live actions while held do not upload: the edit and the delete the user made in
      // Obsidian wait in the gated queue (they are deliberate, not held-list material).
      held.fakeVault.write("during-hold.md", "written while on hold");
      await held.fakeVault.delete("other/g0.md");
      held.eventHandler!.flushNow();
      await sleep(300);
      const heldPathHash = hashPathHex(held.keys!.mac_key, "during-hold.md");
      assertEquals(pathVersionCount(server, vaultId, heldPathHash), 0, "no upload while held");
      assert(held.syncManager!.getPendingOps().length > 0, "the ops wait in the queue");
      assert(B.fakeVault.fileExists("other/g0.md"), "the live delete did not reach B");

      await held.syncManager!.resolveMassDeleteHold([]);
      assertEquals(held.pluginSettings.massDeleteHold, null, "the hold is cleared");
      assertEquals(
        tree(held),
        [...FOLDER, ...OTHERS.filter((p) => p !== "other/g0.md"), "during-hold.md"].sort(),
        "every held path is back, the live delete stayed deleted",
      );
      await held.waitForIdle();
      await B.waitForVersion("during-hold.md");
      await B.waitForDeleted("other/g0.md");
      assertEquals(trashCount(server, vaultId), 1, "only the live delete is a trash entry");
      assertEquals(
        tree(B),
        [...FOLDER, ...OTHERS.filter((p) => p !== "other/g0.md"), "during-hold.md"].sort(),
        "the queued live actions landed on B",
      );
      await assertConverged(held, B);

      const versions = versionCount(server, vaultId);
      await held.reconcileNow();
      assertEquals(
        held.pluginSettings.massDeleteHold,
        null,
        "the reconciler does not re-trip on the restored set",
      );
      assertEquals(
        versionCount(server, vaultId),
        versions,
        "nothing was committed after the decision",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "mass-delete-hold - a persisted hold keeps the device offline across a restart; deleting all trashes them",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);

      const again = await restartPlugin(held, server, {
        settings: { massDeleteHold: held.pluginSettings.massDeleteHold },
      });
      await sleep(300);
      assertEquals(again.transport!.getState(), "disconnected", "a held device never connects");
      assertEquals(again.isLive(), false);
      assertEquals(
        again.pluginSettings.massDeleteHold!.files.length,
        20,
        "the hold survived the restart",
      );
      assertEquals(tree(again), [...OTHERS].sort(), "still nothing restored on startup");

      await again.syncManager!.resolveMassDeleteHold(FOLDER);
      assertEquals(again.pluginSettings.massDeleteHold, null, "the hold is cleared");
      assertEquals(tree(again), [...OTHERS].sort(), "the confirmed deletes stay gone");
      await B.waitForDeleted(FOLDER[0]);
      await B.waitForDeleted(FOLDER[FOLDER.length - 1]);
      assertEquals(tree(B), [...OTHERS].sort(), "B lost exactly the confirmed folder");
      assertEquals(
        trashCount(server, vaultId),
        20,
        "each confirmed delete is a server trash entry",
      );

      const versions = versionCount(server, vaultId);
      await again.syncManager!.resolveMassDeleteHold(FOLDER);
      assertEquals(versionCount(server, vaultId), versions, "a second decision is a no-op");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "mass-delete-hold - a mixed decision deletes the selected set, restores the rest, and skips a file that came back",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);

      // f00 is back on disk before the decision: it is left alone even though selected.
      held.fakeVault.write("n/f00.md", "note 0");
      const selected = ["n/f00.md", "n/f01.md", "n/f02.md", "n/f03.md"];

      await held.syncManager!.resolveMassDeleteHold(selected);

      const kept = FOLDER.filter((p) => !selected.includes(p));
      assertEquals(
        tree(held),
        [...OTHERS, "n/f00.md", ...kept].sort(),
        "restored + the reappeared file",
      );
      assertEquals(trashCount(server, vaultId), 3, "f00 was never deleted: 3 of the 4 selected");
      for (const path of ["n/f01.md", "n/f02.md", "n/f03.md"]) {
        await B.waitForDeleted(path);
      }
      await held.waitForIdle();
      assertEquals(
        tree(B),
        [...OTHERS, "n/f00.md", ...kept].sort(),
        "B lost exactly the selected set",
      );
      await assertConverged(held, B);
      assertEquals(
        new TextDecoder().decode(B.fakeVault.files.get("n/f00.md")),
        "note 0",
        "the reappeared file kept its content",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - a restore that cannot be applied keeps the hold in force",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      const failPath = "n/f07.md";
      const write = held.fakeVault.writeBinary.bind(held.fakeVault);
      held.fakeVault.writeBinary = (path: string, data: Uint8Array, opts?: { mtime?: number }) => {
        if (path === failPath) throw new Error("disk full");
        write(path, data, opts);
      };

      await assertRejects(
        () => held.syncManager!.resolveMassDeleteHold([]),
        Error,
        failPath,
      );

      assertEquals(
        held.pluginSettings.massDeleteHold!.files.length,
        20,
        "the hold is still in force",
      );
      assertEquals(held.fakeVault.fileExists(failPath), false, "the failed path is still missing");
      assertEquals(tree(held).length, OTHERS.length + FOLDER.length - 1, "the rest was restored");
      assertEquals(trashCount(server, vaultId), 0, "nothing was deleted");
      // Still gated: a live edit does not reach the server.
      held.fakeVault.write("gate.md", "must wait for the retry");
      held.eventHandler!.flushNow();
      await sleep(300);
      assertEquals(
        pathVersionCount(server, vaultId, hashPathHex(held.keys!.mac_key, "gate.md")),
        0,
        "the queue is still gated",
      );

      // Retrying converges: the restored files are skipped, only the failed one is retried.
      held.fakeVault.writeBinary = write;
      await held.syncManager!.resolveMassDeleteHold([]);
      assertEquals(held.pluginSettings.massDeleteHold, null, "the retry cleared the hold");
      assertEquals(held.fakeVault.fileExists(failPath), true, "the missing file came back");
      await held.waitForIdle();
      await B.waitForVersion("gate.md");
      await assertConverged(held, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - resync from scratch is the restore-everything decision",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      assertEquals(held.isLive(), false, "precondition: a held device has no connection");

      const stats = await held.resyncFromScratch();

      assertEquals(held.pluginSettings.massDeleteHold, null, "the rebuild resolved the hold");
      assertEquals(tree(held), [...FOLDER, ...OTHERS].sort(), "every held path came back");
      assert(stats.appliedFiles >= FOLDER.length, `applied ${stats.appliedFiles} files`);
      assertEquals(trashCount(server, vaultId), 0, "a rebuild never deletes");
      await assertConverged(held, B);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - a rebuild that fails keeps the hold, and nothing is trashed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      const failPath = "n/f07.md";
      const write = held.fakeVault.writeBinary.bind(held.fakeVault);
      held.fakeVault.writeBinary = (path: string, data: Uint8Array, opts?: { mtime?: number }) => {
        if (path === failPath) throw new Error("disk full");
        write(path, data, opts);
      };

      await assertRejects(() => held.resyncFromScratch(), Error);

      // The rebuild is the decision: until it has RETURNED the hold stays in force, so a
      // half-finished rebuild can never let the remaining paths sync as deletes.
      assertEquals(
        held.pluginSettings.massDeleteHold?.files.length,
        20,
        "the hold survived the failed rebuild",
      );
      assertEquals(trashCount(server, vaultId), 0, "nothing was deleted");

      // The failed rebuild leaves no session: restart, then retry the rebuild.
      const again = await restartPlugin(held, server, {
        settings: { massDeleteHold: held.pluginSettings.massDeleteHold },
      });
      const stats = await again.resyncFromScratch();
      assertEquals(
        again.pluginSettings.massDeleteHold,
        null,
        "the finished rebuild resolved the hold",
      );
      assertEquals(tree(again), [...FOLDER, ...OTHERS].sort(), "every held path is back");
      assert(stats.appliedFiles >= FOLDER.length, `applied ${stats.appliedFiles} files`);
      assertEquals(trashCount(server, vaultId), 0, "a rebuild never deletes");
      await assertConverged(again, B);
      // No pause left behind: the resumed session syncs a live edit.
      again.fakeVault.write("after-retry.md", "sync resumed");
      await again.flushPending();
      await B.waitForVersion("after-retry.md");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - resync refuses while the user pause is on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      held.pause();
      held.pluginSettings.pauseAt = Date.now();

      await assertRejects(
        () => held.resyncFromScratch(),
        Error,
        "Resume sync first",
      );
      assertEquals(held.pluginSettings.massDeleteHold!.files.length, 20, "the hold is untouched");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - a second decision while one is in flight is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);

      const first = held.syncManager!.resolveMassDeleteHold([]);
      await assertRejects(
        () => held.syncManager!.resolveMassDeleteHold([]),
        Error,
        "already in progress",
      );
      await first;
      assertEquals(held.pluginSettings.massDeleteHold, null, "the first decision settled");
      assertEquals(tree(held), [...FOLDER, ...OTHERS].sort());
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - a held path that went out of scope is neither restored nor deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      // The user excludes the folder while the review window is open: those paths are no
      // longer synced, so a decision must not keep failing to restore them.
      held.pluginSettings.excludedFolders = ["n/"];

      await held.syncManager!.resolveMassDeleteHold(FOLDER);

      // The observable effect of the decision, read before anything async can land: a path
      // the user excluded is neither queued for deletion nor restored. (tree/trash below are
      // read before a queued delete would commit when the transport is not live yet.)
      assertEquals(
        held.syncManager!.getPendingOps().filter((op) => op.kind === "delete"),
        [],
        "no out-of-scope path is queued for deletion",
      );
      assertEquals(held.pluginSettings.massDeleteHold, null, "the decision went through");
      assertEquals(tree(held), [...OTHERS].sort(), "nothing restored, nothing deleted");
      assertEquals(tree(B), [...FOLDER, ...OTHERS].sort(), "B keeps its copies");
      assertEquals(trashCount(server, vaultId), 0, "no tombstones for out-of-scope paths");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - a decision refuses while the user pause is on",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      held.pause();

      await assertRejects(
        () => held.syncManager!.resolveMassDeleteHold([]),
        Error,
        "Resume sync first",
      );

      assertEquals(held.pluginSettings.massDeleteHold!.files.length, 20, "the hold is untouched");
      assertEquals(tree(held), [...OTHERS].sort(), "nothing was restored");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "mass-delete-hold - restore-all keeps a newer edit another device made while held",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    try {
      await seed(A, B);
      const held = await restartWithDeleted(A, server, FOLDER);
      B.fakeVault.write("n/f07.md", "edited on B while A was on hold");
      await B.flushPending();

      await held.syncManager!.resolveMassDeleteHold([]);

      assertEquals(
        content(held, "n/f07.md"),
        "edited on B while A was on hold",
        "A took B's newer head, not the one it remembered",
      );
      assertEquals(content(B, "n/f07.md"), "edited on B while A was on hold");
      await assertConverged(held, B);
    } finally {
      await stop();
    }
  },
});
