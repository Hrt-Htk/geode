// #582: Delete forever erases a file's history, not just its trash row. The client
// walks the file's History (capped at the trashed head) and sends the names it lived
// at; the server erases exactly those generations. A rename never becomes a trash row,
// so the bulk purges cannot reach a renamed file's history at all.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin, type TestServer, trashCount } from "../../two-vault-driver.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { eraseChain, HistoryWalk } from "../../../plugin/sync/history-fetch.ts";
import { purgeTrashOne } from "../../../plugin/plumbing/trash-client.ts";
import { purgeExpiredTrash } from "../../../server/trash-db.ts";
import { TRASH_RETENTION_DAYS } from "../../../server/compaction.ts";

type Row = { version: number; deleted: number; rename_mark: number };

function chainOf(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): number[] {
  const rows = server.db.prepare(
    "SELECT version FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  ).all(vaultId, hashPathHex(macKey, path)) as Array<{ version: number }>;
  return rows.map((row) => row.version);
}

function headOf(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row {
  const row = server.db.prepare(
    "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
  ).get(vaultId, hashPathHex(macKey, path)) as Row | undefined;
  assert(row, `expected a version for ${path}`);
  return row;
}

function trashCap(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): number {
  const row = server.db.prepare(
    "SELECT head_json FROM trashed_heads WHERE vault_id = ? AND path_hash = ?",
  ).get(vaultId, hashPathHex(macKey, path)) as { head_json: string } | undefined;
  assert(row, `expected a trash row for ${path}`);
  return (JSON.parse(row.head_json) as { version: number }).version;
}

function paths(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

/** Delete forever, the way the trash modal does it: walk the History, then purge. #677,
 * a device token purges only past the server's retention floor (inside it the admin token
 * is required), so age the row past the floor first. */
async function deleteForever(
  dev: TestPlugin,
  server: TestServer,
  vaultId: string,
  path: string,
): Promise<void> {
  const pathHash = hashPathHex(dev.keys!.mac_key, path);
  const cap = trashCap(server, vaultId, path, dev.keys!.mac_key);
  const chain = await eraseChain(dev.transport!, dev.keys!, pathHash, cap);
  server.db.run(
    "UPDATE trashed_heads SET trashed_at = trashed_at - ? WHERE vault_id = ? AND path_hash = ?",
    (TRASH_RETENTION_DAYS + 1) * 86400,
    vaultId,
    pathHash,
  );
  await purgeTrashOne(
    dev.pluginSettings.serverUrl,
    dev.pluginSettings.vaultId,
    dev.pluginSettings.deviceToken,
    pathHash,
    chain,
  );
}

Deno.test({
  name: "delete-forever - a deleted file's history is erased and both devices keep it deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "one");
      await A.flushPending();
      await B.waitForVersion("a.md");
      A.fakeVault.write("a.md", "two");
      await A.flushPending();
      A.fakeVault.delete("a.md");
      await A.flushPending();
      await B.waitForDeleted("a.md");

      const mac = A.keys!.mac_key;
      assertEquals(chainOf(server, vaultId, "a.md", mac), [1, 2, 3]);
      assertEquals(trashCount(server, vaultId), 1);

      await deleteForever(A, server, vaultId, "a.md");

      assertEquals(chainOf(server, vaultId, "a.md", mac), [3], "the tombstone stays, the saves go");
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(paths(A), []);
      assertEquals(paths(B), []);
      assertEquals(headOf(server, vaultId, "a.md", mac).deleted, 1);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "delete-forever - a renamed file's whole chain goes, up to each name's ceiling",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("old.md", "one");
      await A.flushPending();
      await B.waitForVersion("old.md");
      A.fakeVault.write("old.md", "two");
      await A.flushPending();
      A.fakeVault.rename("old.md", "new.md");
      await A.flushPending();
      await B.waitForVersion("new.md");
      await B.waitForDeleted("old.md");
      A.fakeVault.delete("new.md");
      await A.flushPending();
      await B.waitForDeleted("new.md");

      const mac = A.keys!.mac_key;
      assertEquals(chainOf(server, vaultId, "old.md", mac), [1, 2, 3], "two saves + the marker");
      assertEquals(chainOf(server, vaultId, "new.md", mac), [1, 2], "the note + the tombstone");
      assertEquals(trashCount(server, vaultId), 1, "only the last name has a trash row");

      await deleteForever(A, server, vaultId, "new.md");

      assertEquals(chainOf(server, vaultId, "new.md", mac), [2], "the note and its save go");
      assertEquals(
        chainOf(server, vaultId, "old.md", mac),
        [3],
        "the earlier name's saves go; its marker stays as the head, so the name keeps its order",
      );
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(paths(B), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "delete-forever - a bulk purge never touches a renamed file's history",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("kept.md", "one");
      await A.flushPending();
      await B.waitForVersion("kept.md");
      A.fakeVault.write("kept.md", "two");
      await A.flushPending();
      A.fakeVault.rename("kept.md", "moved.md");
      await A.flushPending();
      await B.waitForVersion("moved.md");
      await B.waitForDeleted("kept.md");

      // A second, plain deletion gives the purge something it IS allowed to erase.
      A.fakeVault.write("gone.md", "bye");
      await A.flushPending();
      A.fakeVault.delete("gone.md");
      await A.flushPending();
      await B.waitForDeleted("gone.md");
      server.db.run(
        "UPDATE trashed_heads SET trashed_at = trashed_at - 86400 * 90 WHERE vault_id = ?",
        vaultId,
      );

      const mac = A.keys!.mac_key;
      assertEquals(purgeExpiredTrash(server.db, 30 * 24 * 3600, vaultId), 1);

      assertEquals(chainOf(server, vaultId, "gone.md", mac), [2], "the expired file's save goes");
      assertEquals(
        chainOf(server, vaultId, "kept.md", mac),
        [1, 2, 3],
        "the renamed name keeps its saves and marker",
      );
      assertEquals(chainOf(server, vaultId, "moved.md", mac), [1], "and its note");
      assertEquals(paths(B), ["moved.md"]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "delete-forever - a reused name keeps the live file's history",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("n.md", "first file");
      await A.flushPending();
      await B.waitForVersion("n.md");
      A.fakeVault.write("n.md", "first file, edited");
      await A.flushPending();
      A.fakeVault.rename("n.md", "m.md");
      await A.flushPending();
      await B.waitForVersion("m.md");
      await B.waitForDeleted("n.md");

      // A new file at the old name, then deleted: its trash row owns only its own saves.
      A.fakeVault.write("n.md", "second file");
      await A.flushPending();
      await B.waitForVersion("n.md");
      A.fakeVault.delete("n.md");
      await A.flushPending();
      await B.waitForDeleted("n.md");

      const mac = A.keys!.mac_key;
      assertEquals(
        chainOf(server, vaultId, "n.md", mac),
        [1, 2, 3, 4, 5],
        "two generations, marker, tombstone",
      );

      await deleteForever(A, server, vaultId, "n.md");

      assertEquals(
        chainOf(server, vaultId, "n.md", mac),
        [1, 2, 3, 5],
        "the deleted file's own save goes; the renamed file's chain and the tombstone stay",
      );
      assertEquals(
        chainOf(server, vaultId, "m.md", mac),
        [1],
        "the live renamed file is untouched",
      );
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(paths(B), ["m.md"], "the live file is still there");

      // And the live file's History still walks back across the rename.
      const walk = new HistoryWalk(A.transport!, A.keys!, hashPathHex(mac, "m.md"));
      while (!walk.done) await walk.next();
      assertEquals(
        walk.segments.map((segment) => segment.versions.map((row) => row.version)),
        [[1], [2, 1]],
        "two saves under the old name plus the note",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "delete-forever - the old name can be written again afterwards and reaches the peer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    const body = (dev: TestPlugin, path: string): string => {
      const bytes = dev.fakeVault.files.get(path);
      return bytes ? new TextDecoder().decode(bytes) : "";
    };
    try {
      A.fakeVault.write("old.md", "original");
      await A.flushPending();
      await B.waitForVersion("old.md");
      A.fakeVault.rename("old.md", "new.md");
      await A.flushPending();
      await B.waitForVersion("new.md");
      await B.waitForDeleted("old.md");
      A.fakeVault.delete("new.md");
      await A.flushPending();
      await B.waitForDeleted("new.md");

      await deleteForever(A, server, vaultId, "new.md");

      // #636: the name's head row survives, so a re-created file continues the version
      // order instead of committing against head 0 (a silent server_conflict).
      A.fakeVault.write("old.md", "written again");
      await A.flushPending();
      await B.waitForVersion("old.md");

      const mac = A.keys!.mac_key;
      assertEquals(body(A, "old.md"), "written again");
      assertEquals(body(B, "old.md"), "written again", "the re-created name reaches the peer");
      assertEquals(chainOf(server, vaultId, "old.md", mac), [2, 3], "marker head + the new save");
      assertEquals(headOf(server, vaultId, "old.md", mac).deleted, 0);
    } finally {
      await stop();
    }
  },
});
