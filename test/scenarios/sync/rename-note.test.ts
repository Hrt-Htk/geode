// #583 PR2: end-to-end rename links on two real clients: one marker + one note
// per rename, a remote edit follows the note (decision 2), a concurrent delete
// never turns a rename into a trash entry (§6), a losing second rename leaves a
// plain copy (decision 9) and case-only renames are real renames (decision 7).

import { assert, assertEquals } from "@std/assert";
import {
  pair,
  restartPlugin,
  type TestServer,
  trashCount,
  waitFor,
} from "../../two-vault-driver.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";
import { CommitQueue } from "../../../plugin/sync/commit-queue.ts";
import { vaultRoutes } from "../../../server/routes.ts";

type Row = { version: number; deleted: number; rename_mark: number };

function chain(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

function head(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row {
  const rows = chain(server, vaultId, path, macKey);
  assert(rows.length > 0, `expected a version for ${path}`);
  return rows[rows.length - 1];
}

function conflictFiles(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].filter(isConflictPath);
}

function paths(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

function content(plugin: { fakeVault: { files: Map<string, Uint8Array> } }, path: string): string {
  const body = plugin.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test({
  name: "rename-note - a rename writes one marker + one note and only the new path survives",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();
      await B.waitForVersion("b.md");
      await B.waitForDeleted("a.md");

      const mac = A.keys!.mac_key;
      assertEquals([
        head(server, vaultId, "a.md", mac).deleted,
        head(server, vaultId, "a.md", mac).rename_mark,
      ], [1, RENAME_MARKER]);
      assertEquals([
        head(server, vaultId, "b.md", mac).deleted,
        head(server, vaultId, "b.md", mac).rename_mark,
      ], [0, RENAME_NOTE]);
      assertEquals(trashCount(server, vaultId), 0, "a marker is never a trash entry");
      assertEquals(paths(B), ["b.md"]);
      assertEquals(content(B, "b.md"), "body");
      assertEquals(conflictFiles(B), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - §4 a local edit under the old name follows the note to the new name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "original");
      await A.flushPending();
      await B.waitForVersion("a.md");

      B.pause();
      B.fakeVault.write("a.md", "edited by B");
      B.eventHandler?.flushNow();
      await sleep(200);

      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();

      await B.resume();
      await B.waitForIdle();
      await A.waitForConvergence(B, "b.md");

      assertEquals(paths(B), ["b.md"], "no resurrected a.md, no conflict file");
      assertEquals(content(B, "b.md"), "edited by B", "the local edit landed at the new name");
      assertEquals(conflictFiles(B), []);
      assertEquals(conflictFiles(A), []);
      assertEquals(paths(A), ["b.md"]);
      assertEquals(
        content(A, "b.md"),
        "edited by B",
        "the edit follows the note to the other device too",
      );
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-note - §5 two devices rename the same note: the first marker keeps the history, the other file is a copy",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      B.pause();
      // A's rename reaches the server first: it keeps a.md's history.
      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();
      // B renamed the same note to a different name while offline.
      B.fakeVault.rename("a.md", "c.md");
      B.eventHandler?.flushNow();
      await sleep(200);

      await B.resume();
      await B.waitForIdle();
      await A.waitForVersion("c.md");
      await A.waitForVersion("b.md");

      const mac = A.keys!.mac_key;
      assertEquals(
        head(server, vaultId, "b.md", mac).rename_mark,
        RENAME_NOTE,
        "A's rename owns the history",
      );
      assertEquals(
        chain(server, vaultId, "a.md", mac).filter((r) => r.rename_mark === RENAME_MARKER).length,
        1,
        "only the first rename marks the old path",
      );
      assertEquals(
        head(server, vaultId, "c.md", mac).rename_mark,
        0,
        "B's file starts its own history",
      );
      assertEquals(head(server, vaultId, "c.md", mac).deleted, 0);
      assertEquals(trashCount(server, vaultId), 0, "no data erased on either side");
      assertEquals(content(B, "c.md"), "body");
      assertEquals(content(B, "b.md"), "body");
      assertEquals(content(A, "c.md"), "body");
      assertEquals(paths(B), ["b.md", "c.md"]);
      assertEquals(paths(A), ["b.md", "c.md"]);
      assertEquals(conflictFiles(B), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - §6 a concurrent delete never turns the rename into a trash entry",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "survives");
      await A.flushPending();
      await B.waitForVersion("a.md");

      A.pause();
      A.fakeVault.rename("a.md", "b.md");
      A.eventHandler?.flushNow();
      await sleep(200);

      B.fakeVault.delete("a.md");
      await B.flushPending();

      await A.resume();
      await A.waitForIdle();
      await B.waitForVersion("b.md");

      const mac = A.keys!.mac_key;
      const oldChain = chain(server, vaultId, "a.md", mac);
      assertEquals(
        oldChain.map((r) => [r.deleted, r.rename_mark]),
        [[0, 0], [1, 0], [1, RENAME_MARKER]],
        "B's tombstone landed first, then A's marker promoted over it",
      );
      assertEquals(trashCount(server, vaultId), 0, "the marker promoted over the tombstone");
      assertEquals(content(B, "b.md"), "survives");
      assertEquals(paths(B), ["b.md"]);
      assertEquals(paths(A), ["b.md"]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - #596 an offline delete over a peer's marker never becomes a trash entry",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "survives");
      await A.flushPending();
      await B.waitForVersion("a.md");

      // B is offline: A renames a.md -> b.md, so the marker is a head B cannot see.
      B.pause();
      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();
      await A.waitForIdle();

      // B deletes a.md while offline. It cannot see the marker, so the delete it
      // queues is a plain tombstone at the marker's head.
      B.fakeVault.delete("a.md");
      B.eventHandler?.flushNow();
      await sleep(200);
      await B.resume();
      await B.waitForIdle();

      const mac = A.keys!.mac_key;
      const marker = head(server, vaultId, "a.md", mac);
      assertEquals([marker.deleted, marker.rename_mark], [1, RENAME_MARKER]);
      const markerMeta = await B.transport!.getVersionChain(hashPathHex(mac, "a.md"));
      const acked = await B.transport!.commit({
        path_hash: hashPathHex(mac, "a.md"),
        parent_version: marker.version,
        enc_metadata: markerMeta[0].enc_metadata,
        chunk_hashes: [],
        deleted: true,
      });
      assertEquals(acked.kind, "ack", "the plain tombstone still lands");

      assertEquals(
        chain(server, vaultId, "a.md", mac).map((r) => [r.deleted, r.rename_mark]),
        [[0, 0], [1, RENAME_MARKER], [1, 0]],
        "plain tombstone on top of the marker",
      );
      assertEquals(trashCount(server, vaultId), 0, "a rename-closed name is never trashed");

      const token = (server.db
        .prepare("SELECT token FROM devices WHERE vault_id = ? LIMIT 1")
        .get(vaultId) as { token: string }).token;
      const restore = await vaultRoutes(server.db, null, server.dataDir)(
        new Request(
          `http://localhost/vaults/${vaultId}/trash/${hashPathHex(mac, "a.md")}/restore`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          },
        ),
      );
      assertEquals(restore.status, 404, "the renamed-away name cannot be restored");

      await A.waitForConvergence(B, "b.md");
      assertEquals(paths(A), ["b.md"]);
      assertEquals(paths(B), ["b.md"], "no resurrected a.md");
      assertEquals(content(B, "b.md"), "survives");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - §9 a case-only rename is a real rename",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("n.md", "body");
      await A.flushPending();
      await B.waitForVersion("n.md");

      A.fakeVault.rename("n.md", "N.md");
      await A.flushPending();
      await B.waitForVersion("N.md");
      await B.waitForDeleted("n.md");

      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "n.md", mac).rename_mark, RENAME_MARKER);
      assertEquals(head(server, vaultId, "N.md", mac).rename_mark, RENAME_NOTE);
      assertEquals(paths(B), ["N.md"]);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a folder rename emits one marker + one note per file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      for (const n of ["1", "2", "3"]) A.fakeVault.write(`dir/${n}.md`, `note ${n}`);
      await A.flushPending();
      for (const n of ["1", "2", "3"]) await B.waitForVersion(`dir/${n}.md`);

      // Obsidian fires one rename event per child for a folder move.
      for (const n of ["1", "2", "3"]) A.fakeVault.rename(`dir/${n}.md`, `moved/${n}.md`);
      await A.flushPending();
      for (const n of ["1", "2", "3"]) {
        await B.waitForVersion(`moved/${n}.md`);
        await B.waitForDeleted(`dir/${n}.md`);
      }

      const mac = A.keys!.mac_key;
      for (const n of ["1", "2", "3"]) {
        assertEquals(head(server, vaultId, `dir/${n}.md`, mac).rename_mark, RENAME_MARKER);
        assertEquals(head(server, vaultId, `moved/${n}.md`, mac).rename_mark, RENAME_NOTE);
      }
      assertEquals(paths(B), ["moved/1.md", "moved/2.md", "moved/3.md"]);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a reconciler create cannot strip the note from a queued rename",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      // The reconciler sees the new path untracked and supersedes the rename
      // event's own commit op: the note must survive that replacement.
      A.fakeVault.rename("a.md", "b.md");
      A.eventHandler!.flushNow();
      await A.syncManager!.reconcileNow();
      await A.waitForIdle();
      await B.waitForVersion("b.md");

      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "b.md", mac).rename_mark, RENAME_NOTE);
      assertEquals(head(server, vaultId, "a.md", mac).rename_mark, RENAME_MARKER);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a copied file (identical content) never claims a note",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "same body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      A.fakeVault.write("copy.md", "same body");
      await A.flushPending();
      await B.waitForVersion("copy.md");

      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "copy.md", mac).rename_mark, 0);
      assertEquals(head(server, vaultId, "a.md", mac).rename_mark, 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a heads-based rebuild keeps only the new path",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();
      await B.waitForVersion("b.md");

      // Heads-based apply must read the marker as a rename, not resurrect a.md.
      await B.resyncFromScratch();
      assertEquals(paths(B), ["b.md"]);
      assertEquals(content(B, "b.md"), "body");
      assertEquals(trashCount(server, vaultId), 0);
      assert(B.fakeVault.fileExists("a.md") === false, "no resurrected old path after a rebuild");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - §4b a rename that also edits keeps both edits",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "one\ntwo\nthree\n");
      await A.flushPending();
      await B.waitForVersion("a.md");

      B.pause();
      B.fakeVault.write("a.md", "one B\ntwo\nthree\n");
      B.eventHandler?.flushNow();
      await sleep(100);

      // A renames AND edits: the note carries content change A, B's edit is B's.
      A.fakeVault.write("a.md", "one\ntwo\nthree A\n");
      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();

      await B.resume();
      await B.waitForIdle();
      await A.waitForConvergence(B, "b.md");

      const carried = [...B.fakeVault.files.entries()].map(([p, d]) => [
        p,
        new TextDecoder().decode(d),
      ]);
      assert(
        carried.some(([, c]) => c.includes("one B")),
        `B's edit must survive somewhere: ${JSON.stringify(carried)}`,
      );
      assertEquals(
        carried.some(([p]) => p === "a.md"),
        false,
        "the old name never comes back",
      );
      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "a.md", mac).rename_mark, RENAME_MARKER);
      assertEquals(head(server, vaultId, "b.md", mac).rename_mark, RENAME_NOTE);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a taken destination keeps the local edit as its own file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "A body");
      A.fakeVault.write("b.md", "B body");
      await A.flushPending();
      await B.waitForVersion("a.md");
      await B.waitForVersion("b.md");

      B.pause();
      B.fakeVault.write("a.md", "A body edited");
      B.eventHandler?.flushNow();
      await sleep(100);

      // The destination name already has a history: no note, no move for B.
      A.fakeVault.rename("a.md", "b.md");
      await A.flushPending();

      await B.resume();
      await B.waitForIdle();
      await A.waitForConvergence(B, "b.md");

      // The old name must never come back: the edit is kept next to the new name.
      assertEquals(B.fakeVault.fileExists("a.md"), false, "no resurrected old name");
      assertEquals(content(B, "b.md"), "A body");
      const kept = conflictFiles(B).map((p) => content(B, p));
      assertEquals(kept, ["A body edited"], "the edit survives as a conflict file");
      const mac = A.keys!.mac_key;
      assertEquals(
        chain(server, vaultId, "a.md", mac).some((r) => r.rename_mark === RENAME_MARKER),
        true,
        "the rename was still recorded",
      );
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - an edit that reaches the server before the rename moves to the new name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "one\ntwo\nthree\n");
      await A.flushPending();
      await B.waitForVersion("a.md");

      A.pause();
      A.fakeVault.write("a.md", "one\ntwo\nthree A\n");
      A.fakeVault.rename("a.md", "b.md");
      A.eventHandler?.flushNow();
      await sleep(100);

      // The editor reaches the server first.
      B.fakeVault.write("a.md", "one B\ntwo\nthree\n");
      await B.flushPending();

      await A.resume();
      await A.waitForIdle();
      await B.waitForVersion("b.md");

      assertEquals(
        content(A, "b.md"),
        "one B\ntwo\nthree A\n",
        "both edits merged at the new name",
      );
      assertEquals(A.fakeVault.fileExists("a.md"), false, "no resurrected old name");
      assertEquals(conflictFiles(A), [], "no empty conflict file");
      assertEquals(content(B, "b.md"), "one B\ntwo\nthree A\n");
      assertEquals(B.fakeVault.fileExists("a.md"), false);
      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "a.md", mac).rename_mark, RENAME_MARKER);
      assertEquals(head(server, vaultId, "a.md", mac).deleted, 1);
      assertEquals(head(server, vaultId, "b.md", mac).rename_mark, RENAME_NOTE);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test("rename-note - a later op keeps the link only inside the same rename", async () => {
  const queue = new CommitQueue({
    pendingRenameTarget: () => undefined,
    vault: {} as never,
    getState: () => null,
    getKeys: () => null,
    transport: { getState: () => "live" } as never,
    onConflict: () => {},
    onStatusUpdate: () => {},
    onConflictFileDeleted: () => {},
  });
  queue.setPaused(true);
  await queue.enqueue(
    [{ path: "b.md", kind: "commit", renamedFrom: "a.md", renameId: "r1" }],
    "test",
  );
  // A different rename (or a fresh intent) on the same path is not the same rename,
  // even in the same millisecond: no stale link.
  await queue.enqueue([{ path: "b.md", kind: "create", renameId: "r2" }], "test");
  assertEquals(queue.getPendingOps()[0].renamedFrom, undefined);

  await queue.enqueue(
    [{ path: "b.md", kind: "commit", renamedFrom: "a.md", renameId: "r3" }],
    "test",
  );
  // An op with no rename of its own (the reconciler, a later event) keeps the link.
  await queue.enqueue([{ path: "b.md", kind: "create" }], "test");
  assertEquals(queue.getPendingOps()[0].renamedFrom, "a.md");
  assertEquals(queue.getPendingOps()[0].renameId, "r3");
});

Deno.test({
  name: "rename-note - a conflicting race at the destination still reaches the other device",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "one\ntwo\nthree\n");
      await A.flushPending();
      await B.waitForVersion("a.md");

      // A goes offline, edits AND renames; B edits the same line and commits.
      A.pause();
      A.fakeVault.write("a.md", "one\nTWO-A\nthree\n");
      A.fakeVault.rename("a.md", "b.md");
      A.eventHandler?.flushNow();
      await sleep(100);
      B.fakeVault.write("a.md", "one\nTWO-B\nthree\n");
      await B.flushPending();

      await A.resume();
      await A.waitForIdle();
      await A.reconcileNow();
      await A.waitForConvergence(B, "b.md");

      // Both edits survive on BOTH devices; the new name reaches the other device (the
      // bug: the destination was written but never committed, so B never saw it).
      await waitFor(
        () =>
          [...B.fakeVault.files.values()].some((d) =>
            new TextDecoder().decode(d).includes("TWO-A")
          ),
        "the kept edit to reach B",
        10_000,
      );
      for (const [label, dev] of [["A", A], ["B", B]] as const) {
        const all = [...dev.fakeVault.files.entries()].map((
          [p, d],
        ) => [p, new TextDecoder().decode(d)]);
        assert(
          all.some(([, c]) => c.includes("TWO-A")),
          `${label}: A's edit survived: ${JSON.stringify(all)}`,
        );
        assert(
          all.some(([, c]) => c.includes("TWO-B")),
          `${label}: B's edit survived: ${JSON.stringify(all)}`,
        );
        assertEquals(dev.fakeVault.fileExists("a.md"), false, `${label}: no resurrected old name`);
      }
      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "b.md", mac).deleted, 0);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-note - an inbound edit while the rename is still pending never reopens the old name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("n0.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("n0.md");

      // B renames locally (its ops sit in the debounce window) ...
      B.fakeVault.rename("n0.md", "n1.md");
      // ... and A's edit on the old name lands on the server first.
      A.fakeVault.write("n0.md", "v1\nA-edit\n");
      await A.flushPending();
      await sleep(100);

      await B.pushNow();
      await B.waitForIdle();
      await A.waitForConvergence(B, "n1.md");

      assertEquals(B.fakeVault.fileExists("n0.md"), false, "B must not write the old name back");
      assertEquals(content(B, "n1.md"), "v1\nA-edit\n", "A's edit moved to the new name");
      await A.waitForDeleted("n0.md");
      const mac = A.keys!.mac_key;
      assertEquals(head(server, vaultId, "n0.md", mac).rename_mark, RENAME_MARKER);
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a write under a name the server already renamed away follows the note",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("n0.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("n0.md");

      B.fakeVault.rename("n0.md", "n1.md");
      await B.flushPending();
      // A sees the rename (marker + note) before its user saves the stale editor.
      await A.waitForDeleted("n0.md");
      await A.waitForVersion("n1.md");

      A.fakeVault.write("n0.md", "v1\nA-late-edit\n");
      await A.flushPending();
      await A.reconcileNow();
      await A.waitForIdle();

      assert(A.fakeVault.fileExists("n0.md") === false, "the old name must not reopen on A");
      await expectConverged("n1.md", A, B);
      const all = [...A.fakeVault.files.entries()].map((
        [p, d],
      ) => [p, new TextDecoder().decode(d)]);
      assert(
        all.some(([, c]) => c.includes("A-late-edit")),
        `late edit survived: ${JSON.stringify(all)}`,
      );
      const mac = A.keys!.mac_key;
      assertEquals(
        chain(server, vaultId, "n0.md", mac).filter((r) => !r.deleted).length,
        1,
        "only the original version",
      );
      assertEquals(trashCount(server, vaultId), 0);
    } finally {
      await stop();
    }
  },
});

function expectConverged(
  path: string,
  a: { fakeVault: { files: Map<string, Uint8Array> } },
  b: { fakeVault: { files: Map<string, Uint8Array> } },
): void {
  const enc = new TextDecoder();
  const aw = enc.decode(a.fakeVault.files.get(path) ?? new Uint8Array());
  const bw = enc.decode(b.fakeVault.files.get(path) ?? new Uint8Array());
  assertEquals(aw, bw, `diverged at ${path}`);
}

/** A renames x.md -> y.md while B's edit of x.md is already on the server: the inbound
 * version arrives while the rename delete is still queued (the deferral path). */
async function deferAcrossRename(
  A: Awaited<ReturnType<typeof pair>>["A"],
  B: Awaited<ReturnType<typeof pair>>["B"],
): Promise<void> {
  A.fakeVault.write("x.md", "v1\n");
  await A.flushPending();
  await B.waitForVersion("x.md");

  // Gate only the commit queue (the transport stays live) so the rename's ops stay
  // queued while B's version arrives: the deferral path.
  A.syncManager!.pause();
  A.fakeVault.rename("x.md", "y.md");
  A.eventHandler?.flushNow();
  await sleep(50);

  B.fakeVault.write("x.md", "v1\nB-edit\n");
  await B.flushPending();
  await sleep(200);
  A.syncManager!.resume();
}

/** B's edit is on A's disk (at the new name, in a merge, or as a conflict sibling). */
function hasPeerEdit(dev: { fakeVault: { files: Map<string, Uint8Array> } }): boolean {
  return [...dev.fakeVault.files.values()].some((d) =>
    new TextDecoder().decode(d).includes("B-edit")
  );
}

Deno.test({
  name: "rename-note - a deferred peer version survives the rename op throwing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("x.md");
      A.syncManager!.pause();
      A.fakeVault.rename("x.md", "y.md");
      A.eventHandler?.flushNow();
      await sleep(50);
      // B's edit arrives while the rename is queued and cannot be carried (every chain
      // lookup fails): the deferred version must survive the op being dropped.
      const chain = A.transport!.getVersionChain.bind(A.transport);
      A.transport!.getVersionChain = () => Promise.reject(new Error("503 unavailable"));
      B.fakeVault.write("x.md", "v1\nB-edit\n");
      await B.flushPending();
      await sleep(100);
      // Reconnect: the queue drains, the marker's conflict throws, the op is dropped.
      await A.resume();
      await sleep(400);
      A.transport!.getVersionChain = chain;
      // The retry is best-effort per sync cycle: the next pass applies it.
      await A.reconcileNow();
      await A.waitForIdle();

      // The rename never landed: B's edit must still reach this device's disk.
      await waitFor(() => hasPeerEdit(A), "B's edit on A after the failed rename", 10_000);
      assert(hasPeerEdit(A), `A lost B's edit: ${JSON.stringify([...A.fakeVault.files.keys()])}`);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a deferred peer version survives an app restart",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    let current = A;
    try {
      await deferAcrossRename(A, B);
      current = await restartPlugin(A, server);
      await current.waitForIdle();
      await current.reconcileNow();
      await waitFor(() => hasPeerEdit(current), "B's edit after a restart", 10_000);
      assert(
        hasPeerEdit(current),
        `the restarted app lost B's edit: ${JSON.stringify([...current.fakeVault.files.keys()])}`,
      );
    } finally {
      current.stop();
      await stop();
    }
  },
});

Deno.test({
  name: "rename-note - a deferred peer version is replayed from the persisted cursor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, stop } = await pair();
    let current = A;
    try {
      await deferAcrossRename(A, B);
      // A lock drops the session (the queued rename ops and the in-memory parking) but
      // keeps the persisted state: the fresh session's replay must deliver the version
      // that was deferred, before any reconcile pass.
      current = await restartPlugin(A, server);
      await current.waitForIdle();
      await waitFor(() => hasPeerEdit(current), "B's edit replayed from the cursor", 10_000);
      assert(
        hasPeerEdit(current),
        `the new session lost B's edit: ${JSON.stringify([...current.fakeVault.files.keys()])}`,
      );
    } finally {
      current.stop();
      await stop();
    }
  },
});
