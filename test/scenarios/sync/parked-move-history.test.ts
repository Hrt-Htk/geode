// #584: a file moved into a folder excluded from sync (#342) and later back out keeps
// ONE history window: the parked name closes with a rename marker naming where the file
// went, and the destination's first version is its note: the same link an in-scope
// rename writes, just resolved later (the move resolves when the file comes back into
// scope, not when it leaves).
//
// The five cases the design must survive: (a) out and back in under a new name, (b) out
// and the folder is re-included, (c) out and deleted there, (d) edits made while parked,
// (e) a peer editing the old name while the file is parked.

import { assert, assertEquals } from "@std/assert";
import {
  pair,
  type PairedVaults,
  type TestServer,
  trashCount,
  waitFor,
} from "../../two-vault-driver.ts";
import { decryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { type FileMeta, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { HistoryWalk } from "../../../plugin/sync/history-fetch.ts";
import { catchUpOrDefer } from "../../../plugin/plumbing/scope-pending.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

type Row = {
  version: number;
  deleted: number;
  rename_mark: number;
  enc_metadata: Uint8Array;
};

function chain(server: TestServer, vaultId: string, path: string, keys: VaultKeys): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(keys.mac_key, path)) as Row[];
}

function head(server: TestServer, vaultId: string, path: string, keys: VaultKeys): Row | undefined {
  return chain(server, vaultId, path, keys).at(-1);
}

async function metaOf(
  server: TestServer,
  vaultId: string,
  path: string,
  keys: VaultKeys,
): Promise<FileMeta> {
  const pathHash = hashPathHex(keys.mac_key, path);
  const row = chain(server, vaultId, path, keys).at(-1)!;
  return await decryptMetadata(row.enc_metadata, keys, pathHash);
}

function paths(plugin: PairedVaults["A"]): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

function content(plugin: PairedVaults["A"], path: string): string {
  const bytes = plugin.fakeVault.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function conflicts(plugin: PairedVaults["A"]): string[] {
  return [...plugin.fakeVault.files.keys()].filter(isConflictPath);
}

function sinkFor(plugin: PairedVaults["A"]): Parameters<typeof catchUpOrDefer>[0] {
  return {
    settings: plugin.pluginSettings,
    saveSettings: async () => {},
    catchUpFolders: (folders) => plugin.syncManager!.catchUpFolders(folders),
  };
}

/** The seq of the first server row of `path` at or past `version`. */
async function waitForSeq(
  server: TestServer,
  vaultId: string,
  path: string,
  keys: VaultKeys,
  version: number,
): Promise<number> {
  let seq = 0;
  await waitFor(
    () => {
      const row = server.db
        .prepare(
          "SELECT seq FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version >= ? ORDER BY version LIMIT 1",
        )
        .get(vaultId, hashPathHex(keys.mac_key, path), version) as { seq: number } | undefined;
      seq = row?.seq ?? 0;
      return seq > 0;
    },
    `server version ${version} of ${path}`,
    15_000,
  );
  return seq;
}

/** The whole history window opened at `path`, read page by page. */
async function window(plugin: PairedVaults["A"], path: string): Promise<HistoryWalk> {
  const walk = new HistoryWalk(
    { getVersionChain: (h, upTo) => plugin.transport!.getVersionChain(h, upTo) },
    plugin.keys!,
    hashPathHex(plugin.keys!.mac_key, path),
  );
  while (!walk.done) await walk.next();
  return walk;
}

Deno.test({
  name: "parked-move - (a) out to an excluded folder and back under a new name: one window",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      // Nothing left the device while the file sat in the excluded folder.
      assertEquals(head(server, vaultId, "notes/a.md", A.keys!)?.deleted, 0);
      assertEquals(B.pluginSettings.pendingMoveOuts.length, 1, "the move is parked");

      // (d) an edit made inside the excluded folder must survive the move back out.
      B.fakeVault.write("Archive/a.md", "one\ntwo edited in archive\n");
      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();

      const marker = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals([marker.deleted, marker.rename_mark], [1, RENAME_MARKER]);
      assertEquals((await metaOf(server, vaultId, "notes/a.md", A.keys!)).renamed_to, "notes/b.md");
      const note = head(server, vaultId, "notes/b.md", A.keys!)!;
      assertEquals([note.deleted, note.rename_mark], [0, RENAME_NOTE]);
      const noteMeta = await metaOf(server, vaultId, "notes/b.md", A.keys!);
      assertEquals(noteMeta.renamed_from, "notes/a.md");
      assertEquals(noteMeta.renamed_from_version, marker.version);
      assertEquals(trashCount(server, vaultId), 0, "a marker is never a trash entry");

      // The window runs from the new name back to the original saves.
      assertEquals(B.pluginSettings.pendingMoveOuts, [], "the parked move is consumed");
      const walk = await window(A, "notes/b.md");
      assertEquals(walk.segments.map((s) => s.from), ["notes/a.md", null]);
      assertEquals(walk.rows().length, 2, "the note and the original save");

      await A.waitForVersion("notes/b.md");
      await A.waitForDeleted("notes/a.md");
      assertEquals(content(B, "notes/b.md"), "one\ntwo edited in archive\n");
      assertEquals(content(A, "notes/b.md"), "one\ntwo edited in archive\n");
      assertEquals(paths(B), ["notes/b.md"]);
      assertEquals(conflicts(B), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - (a2) a move inside the excluded folder keeps the parked link",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "body\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      B.fakeVault.rename("Archive/a.md", "Archive/deep/a.md");
      await B.flushPending();
      assertEquals(B.pluginSettings.pendingMoveOuts.map((m) => m.destPath), ["Archive/deep/a.md"]);

      B.fakeVault.rename("Archive/deep/a.md", "notes/b.md");
      await B.flushPending();

      assertEquals(head(server, vaultId, "notes/a.md", A.keys!)?.rename_mark, RENAME_MARKER);
      assertEquals(head(server, vaultId, "notes/b.md", A.keys!)?.rename_mark, RENAME_NOTE);
      const walk = await window(A, "notes/b.md");
      assertEquals(walk.segments.map((s) => s.from), ["notes/a.md", null]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - a round trip to the same name writes no link: the chain continues",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      B.fakeVault.write("Archive/a.md", "one\ntwo\n");
      B.fakeVault.rename("Archive/a.md", "notes/a.md");
      await B.flushPending();

      const rows = chain(server, vaultId, "notes/a.md", A.keys!);
      assertEquals(rows.map((r) => [r.version, r.deleted, r.rename_mark]), [
        [1, 0, 0],
        [2, 0, 0],
      ], "no marker and no note for a file that never left its name");
      await A.waitForVersion("notes/a.md", 2);
      assertEquals(content(A, "notes/a.md"), "one\ntwo\n");
      assertEquals(B.pluginSettings.pendingMoveOuts, []);
      const walk = await window(A, "notes/a.md");
      assertEquals(walk.segments.length, 1);
      assertEquals(walk.rows().length, 2);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - (b) out and the folder is re-included: marker + note at the excluded name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      B.fakeVault.write("Archive/a.md", "one\ntwo\n");
      await B.flushPending();

      B.pluginSettings.excludedFolders = [];
      await catchUpOrDefer(sinkFor(B), ["Archive/"], () => {});
      await B.waitForIdle();
      await B.reconcileNow();
      await A.waitForIdle();

      const marker = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals([marker.deleted, marker.rename_mark], [1, RENAME_MARKER]);
      assertEquals(
        (await metaOf(server, vaultId, "notes/a.md", A.keys!)).renamed_to,
        "Archive/a.md",
      );
      const note = head(server, vaultId, "Archive/a.md", A.keys!)!;
      assertEquals([note.deleted, note.rename_mark], [0, RENAME_NOTE]);
      const noteMeta = await metaOf(server, vaultId, "Archive/a.md", A.keys!);
      assertEquals(noteMeta.renamed_from, "notes/a.md");
      assertEquals(noteMeta.renamed_from_version, marker.version);
      assertEquals(trashCount(server, vaultId), 0);

      await A.waitForVersion("Archive/a.md");
      await A.waitForDeleted("notes/a.md");
      assertEquals(content(A, "Archive/a.md"), "one\ntwo\n");
      assertEquals(B.pluginSettings.pendingMoveOuts, []);

      const walk = await window(A, "Archive/a.md");
      assertEquals(walk.segments.map((s) => s.from), ["notes/a.md", null]);
      assertEquals(walk.rows().length, 2);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - (c) out and deleted there: one plain tombstone, the history is trashed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      B.fakeVault.delete("Archive/a.md");
      await B.flushPending();

      const gone = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals([gone.deleted, gone.rename_mark], [1, 0], "a plain tombstone, not a marker");
      assertEquals(trashCount(server, vaultId), 1, "the original is in the trash with its history");
      assertEquals(B.pluginSettings.pendingMoveOuts, []);

      await A.waitForDeleted("notes/a.md");
      assertEquals(paths(A), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - (c2) out, deleted there while the app was closed: re-include tombstones it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();
      B.stop();
      B.fakeVault.files.delete("Archive/a.md");

      await B.start();
      await B.waitForIdle();
      B.pluginSettings.excludedFolders = [];
      await catchUpOrDefer(sinkFor(B), ["Archive/"], () => {});
      await B.reconcileNow();
      await B.waitForIdle();
      await waitFor(
        () => trashCount(server, vaultId) === 1,
        "the vanished file to reach the server trash",
        15_000,
      );

      const gone = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals(gone.deleted, 1);
      assertEquals(gone.rename_mark, 0, "the file is gone for sync, not moved");
      await A.waitForDeleted("notes/a.md");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "parked-move - (e) a peer edits the old name while parked: both edits survive, no resurrected name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "line one\nline two\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // The peer edits the original while the file is parked here.
      A.fakeVault.write("notes/a.md", "line one\nline two\npeer line\n");
      await A.flushPending();
      const editSeq = await waitForSeq(server, vaultId, "notes/a.md", A.keys!, 2);
      await B.waitForCaughtUp(editSeq);

      // Never resurrected: the parked file stays at its excluded name only.
      assert(!B.fakeVault.fileExists("notes/a.md"), "the old name is not resurrected");

      B.fakeVault.write("Archive/a.md", "local line\nline one\nline two\n");
      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();
      await A.waitForIdle();

      assertEquals(paths(B), ["notes/b.md"], "no resurrected notes/a.md");
      assertEquals(conflicts(B), []);
      const merged = content(B, "notes/b.md");
      assert(merged.includes("local line"), `local edit kept: ${merged}`);
      assert(merged.includes("peer line"), `peer edit kept: ${merged}`);
      await A.waitForVersion("notes/b.md");
      await A.waitForDeleted("notes/a.md");
      assertEquals(content(A, "notes/b.md"), merged);

      const walk = await window(B, "notes/b.md");
      assertEquals(walk.segments.map((s) => s.from), ["notes/a.md", null]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "parked-move - a peer renames the old name away while parked: no second history, no resurrect",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // Another device renames the old name away while this device's file is parked.
      A.fakeVault.rename("notes/a.md", "notes/c.md");
      await A.flushPending();
      await B.waitForIdle();

      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();
      await A.waitForIdle();

      // Decision 9: the first marker keeps the history, this device's file is a plain
      // copy, and the renamed-away name is never resurrected on either device.
      const marker = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals([marker.deleted, marker.rename_mark], [1, RENAME_MARKER]);
      assertEquals(head(server, vaultId, "notes/b.md", A.keys!)?.rename_mark, 0);
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(paths(B), ["notes/b.md", "notes/c.md"]);
      assertEquals(paths(A), ["notes/b.md", "notes/c.md"]);
      assertEquals(content(B, "notes/b.md"), "one\n");
      assertEquals(content(B, "notes/c.md"), "one\n");
    } finally {
      await stop();
    }
  },
});

// ── review pass on PR #637 ─────────────────────────────────────────────

Deno.test({
  name: "parked-move - a re-created old name is a different file: edits apply, no marker closes it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // The parked name is opened again by a NEW file on this device.
      B.fakeVault.write("notes/a.md", "a new file\n");
      await B.flushPending();
      // A peer edits that new file: the version must land, not be skipped as "parked".
      A.fakeVault.write("notes/a.md", "peer edit of the new file\n");
      await A.flushPending();
      await waitFor(
        () => content(B, "notes/a.md") === "peer edit of the new file\n",
        "the peer's edit of the new file to apply",
        15_000,
      ).catch(() => {});

      assertEquals(content(B, "notes/a.md"), "peer edit of the new file\n");

      // Resolving the park must not close the new file's name: it is a plain copy.
      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();
      await A.waitForVersion("notes/b.md");

      const live = head(server, vaultId, "notes/a.md", A.keys!)!;
      assertEquals([live.deleted, live.rename_mark], [0, 0], "the new file's name stays open");
      assertEquals(head(server, vaultId, "notes/b.md", A.keys!)?.rename_mark, 0);
      assertEquals(content(B, "notes/a.md"), "peer edit of the new file\n");
      assertEquals(content(B, "notes/b.md"), "one\n");
      assertEquals(paths(B), ["notes/a.md", "notes/b.md"]);
      assertEquals(B.pluginSettings.pendingMoveOuts, []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - a park that lands while a re-include settles survives",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    const stat = B.fakeVault.adapter.stat.bind(B.fakeVault.adapter);
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      A.fakeVault.write("notes/z.md", "zed\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");
      await B.waitForVersion("notes/z.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // Re-include: the settle pass awaits a stat per completed move. Hold that await
      // open and park a second file while the pass is suspended.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      B.fakeVault.adapter.stat = async (path: string) => {
        await gate;
        return await stat(path);
      };
      B.pluginSettings.excludedFolders = [];
      const catchingUp = catchUpOrDefer(sinkFor(B), ["Archive/"], () => {});
      await new Promise((r) => setTimeout(r, 50));
      B.pluginSettings.excludedFolders = ["Other/"];
      B.fakeVault.rename("notes/z.md", "Other/z.md");
      await new Promise((r) => setTimeout(r, 50));
      release();
      await catchingUp;
      await B.waitForIdle();

      assertEquals(
        B.pluginSettings.pendingMoveOuts.map((m) => [m.oldPath, m.destPath]),
        [["notes/z.md", "Other/z.md"]],
        "the park that landed during the pass is not overwritten by a stale snapshot",
      );
      assertEquals(head(server, vaultId, "notes/a.md", A.keys!)?.rename_mark, RENAME_MARKER);
    } finally {
      B.fakeVault.adapter.stat = stat;
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - resync from scratch while parked never resurrects the old name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      await B.resyncFromScratch();

      assert(!B.fakeVault.fileExists("notes/a.md"), "the parked name is never rewritten");
      assertEquals(
        B.pluginSettings.pendingMoveOuts.length,
        1,
        "the parked move survives the rebuild",
      );

      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();
      await A.waitForVersion("notes/b.md");
      assertEquals(head(server, vaultId, "notes/a.md", A.keys!)?.rename_mark, RENAME_MARKER);
      assertEquals(head(server, vaultId, "notes/b.md", A.keys!)?.rename_mark, RENAME_NOTE);
      assertEquals(paths(B), ["notes/b.md"]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - a lost link op leaves the old name settleable, never stuck closed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "one\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // Gate the queue: the resolution parks its marker + note but never runs them,
      // the same state a restart in that window (or 5 failed retries) leaves behind.
      B.syncManager!.pause();
      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(B.pluginSettings.pendingMoveOuts, []);
      assertEquals(B.state?.getLocalFile("notes/a.md")?.deleted, false, "the name is releasable");

      // Restart: the queued ops are gone. The old name is still open on the server, so
      // the reconciler must close it instead of leaving it behind forever.
      B.stop();
      await B.start();
      await B.reconcileNow();
      await B.waitForIdle();
      await waitFor(
        () => head(server, vaultId, "notes/a.md", A.keys!)?.deleted === 1,
        "the reconciler to close the un-linked old name",
        15_000,
      );
      assert(!B.fakeVault.fileExists("notes/a.md"), "no resurrected old name");
      assert(B.fakeVault.fileExists("notes/b.md"));
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - two files parked onto one name: the overwritten file is a plain tombstone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/x.md", "ex\n");
      A.fakeVault.write("notes/y.md", "why\n");
      await A.flushPending();
      await B.waitForVersion("notes/x.md");
      await B.waitForVersion("notes/y.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/x.md", "Archive/x.md");
      await B.flushPending();
      // y is moved onto the same parked name (an overwrite): y is the file there now.
      B.fakeVault.rename("notes/y.md", "Archive/x.md");
      await B.flushPending();
      assertEquals(
        B.pluginSettings.pendingMoveOuts.map((m) => [m.oldPath, m.destPath]),
        [["notes/y.md", "Archive/x.md"]],
        "one park per destination, the file that is actually there",
      );

      B.fakeVault.rename("Archive/x.md", "notes/z.md");
      await B.flushPending();
      await A.waitForIdle();

      assertEquals(head(server, vaultId, "notes/z.md", A.keys!)?.rename_mark, RENAME_NOTE);
      assertEquals(
        (await metaOf(server, vaultId, "notes/z.md", A.keys!)).renamed_from,
        "notes/y.md",
        "the link follows the file that ended up at the destination",
      );
      // The overwritten file is gone from disk: its old name gets a plain tombstone.
      await waitFor(
        () => head(server, vaultId, "notes/x.md", A.keys!)?.deleted === 1,
        "the overwritten file's old name to be closed",
        15_000,
      );
      assertEquals(head(server, vaultId, "notes/x.md", A.keys!)?.rename_mark, 0);
      assertEquals(content(B, "notes/z.md"), "why\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "parked-move - resync keeps the park's own anchor: a peer edit still survives it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("notes/a.md", "line one\nline two\n");
      await A.flushPending();
      await B.waitForVersion("notes/a.md");

      B.pluginSettings.excludedFolders = ["Archive/"];
      B.fakeVault.rename("notes/a.md", "Archive/a.md");
      await B.flushPending();

      // A peer edits the parked name; this device skips it (the old name stays closed).
      A.fakeVault.write("notes/a.md", "line one\nline two\npeer line\n");
      await A.flushPending();
      await B.waitForCaughtUp(await waitForSeq(server, vaultId, "notes/a.md", A.keys!, 2));

      // Resync seeds its state from the persisted rows: the park's own anchor (the
      // version this device last saw) must not be moved to the server head, or the
      // marker's parent matches the head and the peer's edit is never carried over.
      await B.resyncFromScratch({ fromPersisted: true });
      assertEquals(B.state?.getLocalFile("notes/a.md")?.last_seen_version, 1);

      B.fakeVault.rename("Archive/a.md", "notes/b.md");
      await B.flushPending();
      await A.waitForVersion("notes/b.md");
      await A.waitForIdle();

      assertEquals(head(server, vaultId, "notes/a.md", A.keys!)?.rename_mark, RENAME_MARKER);
      const live = content(B, "notes/b.md");
      assert(live.includes("peer line"), `the peer's edit is carried over: ${live}`);
      await waitFor(
        () => content(A, "notes/b.md").includes("peer line"),
        "the peer's edit at the renamed file on the other device",
        15_000,
      );
      assertEquals(A.fakeVault.fileExists("notes/a.md"), false);
    } finally {
      await stop();
    }
  },
});
