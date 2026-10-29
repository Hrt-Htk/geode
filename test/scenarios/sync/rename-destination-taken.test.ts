// #600: a live rename onto a name another device's create already took. Decision 9:
// the destination collision makes the renamed file a conflict sibling / copy, but the
// old name must still close as a rename (marker), never as a plain delete: a plain
// tombstone puts the old name in the trash (restorable → resurrection risk) and drops
// the history link.

import { assertEquals } from "@std/assert";
import { pair, trashCount } from "../../two-vault-driver.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { decryptMetadata } from "../../../core/crypto.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

type Row = { version: number; deleted: number; rename_mark: number; enc_metadata: Uint8Array };

function chain(
  server: Awaited<ReturnType<typeof pair>>["server"],
  vaultId: string,
  path: string,
  macKey: Uint8Array,
): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

function bodies(dev: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...dev.fakeVault.files.values()].map((d) => new TextDecoder().decode(d));
}

function conflictFiles(dev: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...dev.fakeVault.files.keys()].filter(isConflictPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A renames x.md -> y.md while B's create of a different y.md is already on the server.
 * The rename is live (the event layer queues the marker): B's create only won the name. */
Deno.test({
  name: "rename-destination-taken - the old name closes as a rename, both files survive",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "X body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // A is gated while B takes the destination name: the rename lands on a name A
      // believes is free, and the note's create collides with a live head.
      A.pause();
      B.fakeVault.write("y.md", "Y body\n");
      await B.flushPending();
      A.fakeVault.rename("x.md", "y.md");
      A.eventHandler!.flushNow();
      await sleep(100);
      await A.resume();
      await A.waitForIdle();
      await B.waitForIdle();
      await A.reconcileNow();
      await B.reconcileNow();
      await sleep(400);

      const mac = A.keys!.mac_key;
      const xRows = chain(server, vaultId, "x.md", mac);
      const xHead = xRows[xRows.length - 1];
      assertEquals(
        [xHead.deleted, xHead.rename_mark],
        [1, RENAME_MARKER],
        "the old name closes as a rename",
      );
      assertEquals(
        trashCount(server, vaultId),
        0,
        "a marker is never a trash entry: the old name is not restorable",
      );
      // The link: the old name closes as a rename pointing at the destination it was
      // given. Decision 9: the destination keeps its own history (B's file), so the
      // renamed bytes are kept next to it and no note is written there.
      const marker = await decryptMetadata(xHead.enc_metadata, A.keys!, hashPathHex(mac, "x.md"));
      assertEquals(marker.renamed_to, "y.md", "the rename is recorded");

      for (const [label, dev] of [["A", A], ["B", B]] as const) {
        assertEquals(
          bodies(dev).some((c) => c === "X body\n"),
          true,
          `${label}: the renamed file's content survives (at y.md or a sibling)`,
        );
        assertEquals(
          bodies(dev).some((c) => c === "Y body\n"),
          true,
          `${label}: the other device's create survives`,
        );
        assertEquals(dev.fakeVault.fileExists("x.md"), false, `${label}: no resurrected old name`);
      }
      assertEquals(conflictFiles(A).length, 1, "the losing side is kept as one sibling");
      assertEquals(conflictFiles(B).length, 1);
      const yHead = chain(server, vaultId, "y.md", mac).at(-1)!;
      assertEquals(yHead.deleted, 0, "B's file stays live");
      assertEquals(yHead.rename_mark, 0, "a taken destination starts no rename history");
      assertEquals(
        chain(server, vaultId, "y.md", mac).some((r) => r.rename_mark === RENAME_NOTE),
        false,
        "no note claims a file that another device created",
      );
    } finally {
      await stop();
    }
  },
});

/** The other order: the rename lands first, and B creates its own y.md while it has not
 * seen the rename: the create collides with a rename note instead of the reverse. */
Deno.test({
  name: "rename-destination-taken - a create colliding with a rename note keeps the marker",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "X body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      B.pause();
      A.fakeVault.rename("x.md", "y.md");
      await A.flushPending();
      B.fakeVault.write("y.md", "Y body\n");
      B.eventHandler!.flushNow();
      await sleep(100);
      await B.resume();
      await B.waitForIdle();
      await A.waitForIdle();
      await B.reconcileNow();
      await sleep(400);

      const mac = A.keys!.mac_key;
      const xRows = chain(server, vaultId, "x.md", mac);
      const xHead = xRows[xRows.length - 1];
      assertEquals([xHead.deleted, xHead.rename_mark], [1, RENAME_MARKER], "the move is recorded");
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(
        chain(server, vaultId, "y.md", mac).some((r) => r.rename_mark === RENAME_NOTE),
        true,
        "the rename's note is on the destination",
      );
      for (const [label, dev] of [["A", A], ["B", B]] as const) {
        assertEquals(
          bodies(dev).some((c) => c === "X body\n"),
          true,
          `${label}: renamed content survives`,
        );
        assertEquals(
          bodies(dev).some((c) => c === "Y body\n"),
          true,
          `${label}: the create survives`,
        );
        assertEquals(dev.fakeVault.fileExists("x.md"), false, `${label}: no resurrected old name`);
      }
    } finally {
      await stop();
    }
  },
});
