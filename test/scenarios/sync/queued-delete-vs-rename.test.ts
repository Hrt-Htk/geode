// #609: a queued plain delete and a rename destination holding the same bytes in one
// reconcile pass: the delete is the event layer's own op, so pairing it with the create
// writes a second marker and steals the real rename's note (fuzz seed 764).

import { assert, assertEquals } from "@std/assert";
import { pair, type TestServer } from "../../two-vault-driver.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { decryptMetadata } from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";

type Row = { version: number; deleted: number; rename_mark: number; enc_metadata: Uint8Array };

function chain(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

function head(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row | null {
  const rows = chain(server, vaultId, path, macKey);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

Deno.test({
  name: "queued-delete-vs-rename - a queued delete is not a rename source",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      // One original under two names with identical bytes: the #609 race left both
      // spellings tracked, so the reconciler sees either as a rename source.
      A.fakeVault.write("n1.md", "same");
      A.fakeVault.write("dir-b/n1.md", "same");
      await A.flushPending();
      await B.waitForVersion("n1.md");
      await B.waitForVersion("dir-b/n1.md");

      // Offline the user deletes one copy and renames the other: the event layer
      // queues both, and a reconcile pass runs before they reach the server.
      B.pause();
      B.fakeVault.delete("n1.md");
      B.fakeVault.rename("dir-b/n1.md", "n4.md");
      B.eventHandler!.flushNow();
      await B.syncManager!.startReconciler();
      await B.syncManager!.reconcileNow();

      await B.resume();
      await B.waitForIdle();
      await A.waitForVersion("n4.md");
      await A.waitForDeleted("n1.md");

      const keys = A.keys!;
      const mac = keys.mac_key;
      assertEquals(
        [
          head(server, vaultId, "dir-b/n1.md", mac)!.deleted,
          head(server, vaultId, "dir-b/n1.md", mac)!.rename_mark,
        ],
        [1, RENAME_MARKER],
        "the real rename marks its own source",
      );
      assertEquals(
        [
          head(server, vaultId, "n1.md", mac)!.deleted,
          head(server, vaultId, "n1.md", mac)!.rename_mark,
        ],
        [1, 0],
        "the queued delete stays a plain delete, not a second marker",
      );
      const note = chain(server, vaultId, "n4.md", mac)[0];
      assertEquals(note.rename_mark, RENAME_NOTE, "the destination opens with a note");
      const meta = await decryptMetadata(note.enc_metadata, keys, hashPathHex(mac, "n4.md"));
      assertEquals(meta.renamed_from, "dir-b/n1.md", "the note belongs to the real rename");

      assertEquals([...A.fakeVault.files.keys()], ["n4.md"], "only the renamed copy survives on A");
      assertEquals([...B.fakeVault.files.keys()], ["n4.md"], "and on B");
      assert(
        new TextDecoder().decode(A.fakeVault.files.get("n4.md")) === "same",
        "the surviving copy keeps its content",
      );
    } finally {
      await stop();
    }
  },
});
