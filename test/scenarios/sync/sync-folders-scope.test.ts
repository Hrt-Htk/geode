import { assert, assertEquals } from "@std/assert";
import { hashPathHex } from "../../../core/hash.ts";
import { pair, type PairedVaults, waitFor } from "../../two-vault-driver.ts";
import { catchUpOrDefer, retryPendingCatchUp } from "../../../plugin/plumbing/scope-pending.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

// #342: folder-level sync scope, two-vault semantics:
//  - out-of-scope paths are skipped in both directions
//  - switching a folder off deletes nothing (local, server, other devices)
//  - re-including catches up to the server heads
//  - local deletes inside an excluded folder do not propagate
//  - renames across the scope boundary are safe

let p: PairedVaults;

Deno.test({
  name: "scope - B excludes a folder: A edits and deletes inside it, B unaffected, server intact",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      // Seed: A creates two files in Projects/, both devices converge.
      A.fakeVault.write("Projects/a.md", "alpha v1");
      A.fakeVault.write("Projects/b.md", "beta v1");
      await A.flushPending();
      await B.waitForVersion("Projects/a.md");
      await B.waitForVersion("Projects/b.md");

      // B excludes Projects/ (per-device setting; reconciler/apply read it live).
      B.pluginSettings.excludedFolders = ["Projects/"];

      // A edits and deletes inside the excluded folder.
      A.fakeVault.write("Projects/a.md", "alpha v2");
      A.fakeVault.delete("Projects/b.md");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/a.md"));

      // B's disk is untouched: a.md still v1, b.md still present.
      assertEquals(content(B, "Projects/a.md"), "alpha v1");
      assert(B.fakeVault.fileExists("Projects/b.md"), "b.md must stay on B's disk");

      // Server intact: a.md at v2, b.md has a delete head.
      assertEquals(serverHead(server, A.keys, "Projects/a.md")?.version, 2);
      assertEquals(serverHead(server, A.keys, "Projects/b.md")?.deleted, true);

      // B's local files under the folder stay on disk after a reconcile.
      await B.reconcileNow();
      assert(B.fakeVault.fileExists("Projects/a.md"));
      assert(B.fakeVault.fileExists("Projects/b.md"));
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - B re-includes: converges to A (edit applied, delete applied)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/a.md", "alpha v1");
      A.fakeVault.write("Projects/b.md", "beta v1");
      await A.flushPending();
      await B.waitForVersion("Projects/a.md");
      await B.waitForVersion("Projects/b.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      A.fakeVault.write("Projects/a.md", "alpha v2");
      A.fakeVault.delete("Projects/b.md");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/a.md"));
      assertEquals(content(B, "Projects/a.md"), "alpha v1");

      // B switches the folder back on and catches up to the server heads.
      B.pluginSettings.excludedFolders = [];
      await B.syncManager.catchUpFolders(["Projects/"]);
      await B.waitForVersion("Projects/a.md", 2);

      assertEquals(content(B, "Projects/a.md"), "alpha v2");
      assert(!B.fakeVault.fileExists("Projects/b.md"), "server delete must apply on re-include");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - local delete inside excluded folder does not propagate",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/c.md", "gamma v1");
      await A.flushPending();
      await B.waitForVersion("Projects/c.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      B.fakeVault.delete("Projects/c.md");
      await B.reconcileNow();
      await A.waitForIdle();

      // A still has the file; the server head is unchanged (v1, not deleted).
      assert(A.fakeVault.fileExists("Projects/c.md"));
      assertEquals(serverHead(server, A.keys, "Projects/c.md")?.version, 1);
      assertEquals(serverHead(server, A.keys, "Projects/c.md")?.deleted, false);
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - local edit while excluded reconciles on re-include (merge path)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/d.md", "shared line\nA line\n");
      await A.flushPending();
      await B.waitForVersion("Projects/d.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      // Both sides edit while B is out of scope (non-overlapping: remote prepends,
      // local appends, so the 3-way merge is clean).
      A.fakeVault.write("Projects/d.md", "A line (remote)\nshared line\nA line\n");
      B.fakeVault.write("Projects/d.md", "shared line\nA line\nB line (local)\n");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/d.md"));
      // B's disk keeps its local edit; nothing was pushed.
      assertEquals(
        content(B, "Projects/d.md"),
        "shared line\nA line\nB line (local)\n",
      );

      B.pluginSettings.excludedFolders = [];
      await B.syncManager.catchUpFolders(["Projects/"]);
      // The catch-up promotes the divergent disk edit to a tracked local edit;
      // the reconciler commits it (stale parent → server conflict → 3-way merge).
      await B.reconcileNow();
      await B.waitForIdle();
      await A.waitForIdle();

      // The local edit was promoted and merged through the existing path:
      // B ends with a file containing BOTH lines (clean 3-way merge).
      await waitFor(
        () => {
          const b = content(B, "Projects/d.md") ?? "";
          return b.includes("B line (local)") && b.includes("A line (remote)");
        },
        "B to merge both local and remote edits",
      );
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - rename across the boundary: into excluded stops syncing, no server delete",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("notes/e.md", "epsilon v1");
      await A.flushPending();
      await B.waitForVersion("notes/e.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      // B moves the file into its excluded folder.
      B.fakeVault.rename("notes/e.md", "Projects/e.md");
      await B.flushPending();
      await A.waitForIdle();

      // No server delete: A still has notes/e.md; the server head is intact.
      assert(A.fakeVault.fileExists("notes/e.md"));
      assertEquals(serverHead(server, A.keys, "notes/e.md")?.deleted, false);
      assertEquals(serverHead(server, A.keys, "notes/e.md")?.version, 1);
      // B's file sits in the excluded folder, unsynced.
      assert(B.fakeVault.fileExists("Projects/e.md"));

      // B moves it back: upload at the original path converges (identical content).
      B.fakeVault.rename("Projects/e.md", "notes/e.md");
      await B.flushPending();
      await A.waitForIdle();
      await B.waitForIdle();
      assertEquals(content(B, "notes/e.md"), "epsilon v1");
      assert(A.fakeVault.fileExists("notes/e.md"));
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - A renames a file into B's excluded folder: B skips, catches up on re-include",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("notes/f.md", "zeta v1");
      await A.flushPending();
      await B.waitForVersion("notes/f.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      // A moves the file into the folder B has excluded.
      A.fakeVault.rename("notes/f.md", "Projects/f.md");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/f.md"));

      // B applied the in-scope delete but skipped the out-of-scope create.
      assert(!B.fakeVault.fileExists("notes/f.md"));
      assert(!B.fakeVault.fileExists("Projects/f.md"));

      // Re-include: the server head for the new path is applied.
      B.pluginSettings.excludedFolders = [];
      await B.syncManager.catchUpFolders(["Projects/"]);
      await B.waitForVersion("Projects/f.md");
      assertEquals(content(B, "Projects/f.md"), "zeta v1");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - delete locally while excluded: re-include restores, never propagates",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/a.md", "alpha v1");
      await A.flushPending();
      await B.waitForVersion("Projects/a.md");

      // B excludes Projects/ and deletes its local copy (free-space use case).
      B.pluginSettings.excludedFolders = ["Projects/"];
      B.fakeVault.delete("Projects/a.md");
      await B.reconcileNow();
      await A.waitForIdle();
      // Nothing propagated while excluded.
      assert(A.fakeVault.fileExists("Projects/a.md"));
      assertEquals(serverHead(server, A.keys, "Projects/a.md")?.deleted, false);

      // Re-include with a failing catch-up: the folder stays pending, and the
      // reconciler must NOT turn the still-missing file into a server delete.
      B.pluginSettings.excludedFolders = [];
      const restore = failNextGetHeads(B);
      await catchUpOrDefer(sinkFor(B), ["Projects/"], () => {});
      assert(B.pluginSettings.pendingCatchUpFolders.includes("Projects/"));
      await B.reconcileNow();
      await A.waitForIdle();
      assert(A.fakeVault.fileExists("Projects/a.md"), "no delete propagated while pending");
      assertEquals(serverHead(server, A.keys, "Projects/a.md")?.deleted, false);

      // The retry succeeds: the file is restored from the server head, pending clears.
      restore();
      await retryPendingCatchUp(sinkFor(B));
      assertEquals(B.pluginSettings.pendingCatchUpFolders, []);
      await B.waitForVersion("Projects/a.md");
      assertEquals(content(B, "Projects/a.md"), "alpha v1");
      assert(A.fakeVault.fileExists("Projects/a.md"));
      assertEquals(serverHead(server, A.keys, "Projects/a.md")?.deleted, false);
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - rename into excluded then re-include: move completes, no duplicate, no loss",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("notes/e.md", "epsilon v1");
      await A.flushPending();
      await B.waitForVersion("notes/e.md");

      // B excludes Projects/ and moves a synced file into it.
      B.pluginSettings.excludedFolders = ["Projects/"];
      B.fakeVault.rename("notes/e.md", "Projects/e.md");
      await B.flushPending();
      await A.waitForIdle();
      // No server delete while excluded: A still has the old name, head intact.
      assert(A.fakeVault.fileExists("notes/e.md"));
      assertEquals(serverHead(server, A.keys, "notes/e.md")?.deleted, false);
      // The move-out was recorded with its destination (#584: the exact path too, so
      // the move resolves as the rename it was instead of splitting the history).
      assertEquals(B.pluginSettings.pendingMoveOuts, [
        { oldPath: "notes/e.md", destPath: "Projects/e.md", destFolder: "Projects/" },
      ]);

      // Re-include Projects/: catch-up completes the move (the old name closes with a
      // rename marker naming the new one, #584; the new path uploads) instead of
      // leaving a duplicate.
      B.pluginSettings.excludedFolders = [];
      await catchUpOrDefer(sinkFor(B), ["Projects/"], () => {});
      await B.reconcileNow();
      await B.waitForIdle();
      await A.waitForIdle();

      // No duplicate and no loss: only Projects/e.md exists everywhere.
      assertEquals(B.pluginSettings.pendingMoveOuts, [], "move-out consumed");
      assert(B.fakeVault.fileExists("Projects/e.md"));
      assertEquals(content(B, "Projects/e.md"), "epsilon v1");
      await A.waitForDeleted("notes/e.md");
      await waitFor(
        () => serverHead(server, A.keys, "notes/e.md")?.deleted === true,
        "old name deleted on the server",
      );
      assert(!A.fakeVault.fileExists("notes/e.md"), "old name removed from other devices");
      await A.waitForVersion("Projects/e.md");
      assert(A.fakeVault.fileExists("Projects/e.md"));
      assertEquals(serverHead(server, A.keys, "Projects/e.md")?.deleted, false);
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - catch-up fails once, converges after retry",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/a.md", "alpha v1");
      await A.flushPending();
      await B.waitForVersion("Projects/a.md");

      B.pluginSettings.excludedFolders = ["Projects/"];
      A.fakeVault.write("Projects/a.md", "alpha v2");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/a.md"));
      assertEquals(content(B, "Projects/a.md"), "alpha v1");

      // Re-include; the first catch-up attempt fails.
      B.pluginSettings.excludedFolders = [];
      const restore = failNextGetHeads(B);
      let notice = "";
      await catchUpOrDefer(sinkFor(B), ["Projects/"], (m) => {
        notice = m;
      });
      // Pending persisted, the user was told (no dashes in the copy).
      assert(B.pluginSettings.pendingCatchUpFolders.includes("Projects/"));
      assert(notice.includes("retry"), "notice copy mentions the retry");
      assert(!notice.includes("-"), "notice copy has no dashes");
      assertEquals(content(B, "Projects/a.md"), "alpha v1");

      // The next reconnect retry succeeds and clears the pending list.
      restore();
      await retryPendingCatchUp(sinkFor(B));
      assertEquals(B.pluginSettings.pendingCatchUpFolders, []);
      await B.waitForVersion("Projects/a.md", 2);
      assertEquals(content(B, "Projects/a.md"), "alpha v2");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name:
    "scope - untracked file with a server head is a conflict on re-include, never silently overwritten",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      // B excludes Projects/ before A creates x.md there.
      B.pluginSettings.excludedFolders = ["Projects/"];
      A.fakeVault.write("Projects/x.md", "alpha v1");
      await A.flushPending();
      A.fakeVault.write("Projects/x.md", "alpha v2");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/x.md"));

      // B drops a DIFFERENT untracked x.md into the folder while excluded.
      B.fakeVault.write("Projects/x.md", "local B content");
      await B.reconcileNow();
      await A.waitForIdle();

      // Re-include: the divergent untracked file must survive via conflict/merge.
      B.pluginSettings.excludedFolders = [];
      await B.syncManager.catchUpFolders(["Projects/"]);
      await B.waitForVersion("Projects/x.md", 2);

      // Server content applied at the path; B's local content in a conflict file.
      assertEquals(content(B, "Projects/x.md"), "alpha v2");
      const conflictPath = [...B.fakeVault.files.keys()]
        .find((path) => path.startsWith("Projects/x (conflict ") && isConflictPath(path));
      assert(conflictPath, "a conflict file must be created");
      assertEquals(content(B, conflictPath!), "local B content");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name:
    "scope - one un-appliable head is a per-file error; folder still clears pending once others converge",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      A.fakeVault.write("Projects/a.md", "alpha v1");
      A.fakeVault.write("Projects/b.md", "beta v1");
      await A.flushPending();
      await B.waitForVersion("Projects/a.md");
      await B.waitForVersion("Projects/b.md");

      // B excludes the folder and deletes b.md locally (restore-on-re-include case).
      B.pluginSettings.excludedFolders = ["Projects/"];
      B.fakeVault.delete("Projects/b.md");
      await B.reconcileNow();
      await A.waitForIdle();

      // A advances a.md's head; B's catch-up must restore b.md but a.md's blob
      // is now missing from the server store, so its head can never apply.
      A.fakeVault.write("Projects/a.md", "alpha v2");
      await A.flushPending();
      await B.waitForCaughtUp(await serverSeq(server, A.keys, "Projects/a.md"));
      const aRow = A.state.getLocalFile("Projects/a.md");
      const hash = aRow!.chunk_hashes[0];
      Deno.removeSync(`${server.dataDir}/blobs/${p.vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`);

      // Re-include: b.md converges, a.md fails per-file; the folder is not held pending.
      B.pluginSettings.excludedFolders = [];
      await catchUpOrDefer(sinkFor(B), ["Projects/"], () => {});
      assertEquals(
        B.pluginSettings.pendingCatchUpFolders,
        [],
        "folder clears once other files converged",
      );
      assertEquals(content(B, "Projects/b.md"), "beta v1", "good file restored");
      // The failure is recorded in the sync activity log (feedback beyond the notice).
      assertEquals(B.activity.entries.get("Projects/a.md")?.kind, "error");
    } finally {
      await p.stop();
    }
  },
});

Deno.test({
  name: "scope - self-authored file deleted locally while excluded restores on re-include",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    p = await pair();
    const { A, B, server } = p;
    try {
      // B authors the file (the head is B's own device), both devices converge.
      B.fakeVault.write("Projects/b.md", "beta v1");
      await B.flushPending();
      await A.waitForVersion("Projects/b.md");

      // B excludes the folder and deletes its local copy.
      B.pluginSettings.excludedFolders = ["Projects/"];
      B.fakeVault.delete("Projects/b.md");
      await B.reconcileNow();
      await A.waitForIdle();
      assert(A.fakeVault.fileExists("Projects/b.md"), "delete never propagates while excluded");

      // Re-include: the force bypass of the own-version branch restores B's own head.
      B.pluginSettings.excludedFolders = [];
      await B.syncManager.catchUpFolders(["Projects/"]);
      await B.waitForVersion("Projects/b.md");
      assertEquals(content(B, "Projects/b.md"), "beta v1");
      assert(A.fakeVault.fileExists("Projects/b.md"), "A unaffected");
      assertEquals(serverHead(server, A.keys, "Projects/b.md")?.deleted, false);
    } finally {
      await p.stop();
    }
  },
});

function content(vault: PairedVaults["A"], path: string): string | undefined {
  const bytes = vault.fakeVault.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

// ── helpers ────────────────────────────────────────────────────────────

/** Build a coordinator sink backed by a real test plugin. */
function sinkFor(
  plugin: PairedVaults["A"],
): Parameters<typeof catchUpOrDefer>[0] {
  return {
    settings: plugin.pluginSettings,
    saveSettings: async () => {},
    catchUpFolders: (folders) => plugin.syncManager.catchUpFolders(folders),
  };
}

/** Make the transport's next getHeads call throw once, then delegate. */
function failNextGetHeads(plugin: PairedVaults["A"]): () => void {
  const orig = plugin.transport.getHeads.bind(plugin.transport);
  let fail = true;
  plugin.transport.getHeads = async function* (afterSeq: number) {
    if (fail) {
      fail = false;
      throw new Error("network down");
    }
    yield* orig(afterSeq);
  } as typeof plugin.transport.getHeads;
  return () => {
    plugin.transport.getHeads = orig as typeof plugin.transport.getHeads;
  };
}

/** Poll the server DB until the path has a version; return its latest seq. */
async function serverSeq(
  server: PairedVaults["server"],
  keys: typeof p.A.keys,
  path: string,
): Promise<number> {
  const ph = hashPathHex(keys.mac_key, path);
  let seq = 0;
  await waitFor(
    () => {
      const row = server.db
        .prepare(
          "SELECT seq FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(p.vaultId, ph) as { seq: number } | undefined;
      seq = row?.seq ?? 0;
      return seq > 0;
    },
    `server version for ${path}`,
    15_000,
  );
  return seq;
}

/** Current server head (max version) for a path. */
function serverHead(
  server: PairedVaults["server"],
  keys: typeof p.A.keys,
  path: string,
): { version: number; deleted: boolean } | null {
  const ph = hashPathHex(keys.mac_key, path);
  const row = server.db
    .prepare(
      "SELECT version, deleted FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
    )
    .get(p.vaultId, ph) as { version: number; deleted: number } | undefined;
  if (!row) return null;
  return { version: row.version, deleted: !!row.deleted };
}
