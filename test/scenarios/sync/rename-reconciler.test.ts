// #583 PR3: a rename the event stream never saw: the reconciler pairs one
// create with one delete of identical content into a marker + a note (decision 5),
// refuses to pair ambiguous batches, keeps a renamed folder from duplicating every
// file (research §1/§3) and suppresses the WHOLE pass when the mass-delete guard
// trips (decision 10).

import { assert, assertEquals } from "@std/assert";
import {
  FakeVault,
  pair,
  restartWithDiskChange,
  type TestPlugin,
  type TestServer,
  trashCount,
  versionCount,
} from "../../two-vault-driver.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";

type Row = { version: number; deleted: number; rename_mark: number };

function chain(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

function head(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row | null {
  const rows = chain(server, vaultId, path, macKey);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/** Paths whose newest server version is not a delete (a marker or a tombstone closes one). */
function liveHeadCount(server: TestServer, vaultId: string): number {
  const row = server.db
    .prepare(
      `SELECT COUNT(*) AS n FROM file_versions fv
        WHERE fv.vault_id = ? AND fv.deleted = 0
          AND fv.version = (SELECT MAX(version) FROM file_versions
                             WHERE vault_id = fv.vault_id AND path_hash = fv.path_hash)`,
    )
    .get(vaultId) as { n: number };
  return row.n;
}

/** Reconcile until the server stops growing: the plugin's own start-up pass races the
 * forced one, so a single reconcileNow can return before its ops land. */
async function settleReconcile(
  plugin: TestPlugin,
  server: TestServer,
  vaultId: string,
): Promise<void> {
  let prev = -1;
  for (let round = 0; round < 8; round++) {
    await plugin.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const count = versionCount(server, vaultId);
    if (count === prev) return;
    prev = count;
  }
  throw new Error("reconcile did not settle");
}

/** A rename behind the app's back: the bytes move, no vault event is emitted. */
function renameSilently(vault: FakeVault, from: string, to: string): void {
  const data = vault.files.get(from);
  assert(data !== undefined, `expected ${from} on disk`);
  const mtime = vault.mtimes.get(from) ?? Date.now();
  vault.files.delete(from);
  vault.mtimes.delete(from);
  vault.files.set(to, new Uint8Array(data));
  vault.mtimes.set(to, mtime);
}

function removeSilently(vault: FakeVault, path: string): void {
  vault.files.delete(path);
  vault.mtimes.delete(path);
}

function writeSilently(vault: FakeVault, path: string, content: string): void {
  vault.files.set(path, new TextEncoder().encode(content));
  vault.mtimes.set(path, Date.now());
}

Deno.test({
  name: "rename-reconciler - a rename the app never saw becomes a marker + a note",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a.md", "body");
      await A.flushPending();
      await B.waitForVersion("a.md");

      const fresh = await restartWithDiskChange(
        A,
        server,
        () => renameSilently(A.fakeVault, "a.md", "b.md"),
      );
      await settleReconcile(fresh, server, vaultId);

      const mac = fresh.keys!.mac_key;
      assertEquals(
        head(server, vaultId, "a.md", mac),
        { version: 2, deleted: 1, rename_mark: RENAME_MARKER },
        "the old name's head is a rename marker",
      );
      assertEquals(
        head(server, vaultId, "b.md", mac)?.rename_mark,
        RENAME_NOTE,
        "the new name's first version is a note",
      );
      assertEquals(chain(server, vaultId, "a.md", mac).length, 2, "no extra old-name version");
      assertEquals(trashCount(server, vaultId), 0, "a marker is never a trash entry");
      assertEquals([...fresh.fakeVault.files.keys()], ["b.md"]);

      await B.waitForVersion("b.md");
      await B.waitForDeleted("a.md");
      assertEquals([...B.fakeVault.files.keys()], ["b.md"]);
      assertEquals(new TextDecoder().decode(B.fakeVault.files.get("b.md")), "body");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-reconciler - two identical notes are not paired (no guessing past decision 5)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("a1.md", "same");
      A.fakeVault.write("a2.md", "same");
      await A.flushPending();

      const fresh = await restartWithDiskChange(A, server, () => {
        renameSilently(A.fakeVault, "a1.md", "b1.md");
        renameSilently(A.fakeVault, "a2.md", "b2.md");
      });
      await settleReconcile(fresh, server, vaultId);

      const mac = fresh.keys!.mac_key;
      for (const path of ["a1.md", "a2.md"]) {
        const row = head(server, vaultId, path, mac)!;
        assertEquals([row.deleted, row.rename_mark], [1, 0], `${path} is a plain delete`);
      }
      for (const path of ["b1.md", "b2.md"]) {
        const row = head(server, vaultId, path, mac)!;
        assertEquals([row.deleted, row.rename_mark], [0, 0], `${path} is a plain create`);
      }
      assertEquals(trashCount(server, vaultId), 2, "plain deletes are trash entries");
      assertEquals([...fresh.fakeVault.files.keys()].sort(), ["b1.md", "b2.md"]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-reconciler - a 20-note folder renamed while closed never doubles the server's paths",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      const names = Array.from({ length: 20 }, (_, i) => `n/f${String(i).padStart(2, "0")}.md`);
      for (const [i, path] of names.entries()) A.fakeVault.write(path, `note ${i}`);
      await A.flushPending();
      assertEquals(liveHeadCount(server, vaultId), 20, "precondition: 20 live paths");

      const fresh = await restartWithDiskChange(A, server, () => {
        for (const path of names) renameSilently(A.fakeVault, path, path.replace(/^n\//, "m/"));
      });
      await settleReconcile(fresh, server, vaultId);

      const mac = fresh.keys!.mac_key;
      assertEquals(liveHeadCount(server, vaultId), 20, "still 20 live paths, never 40");
      for (const [i, path] of names.entries()) {
        const moved = path.replace(/^n\//, "m/");
        assertEquals(
          head(server, vaultId, path, mac)?.rename_mark,
          RENAME_MARKER,
          `${path} is a marker`,
        );
        assertEquals(
          head(server, vaultId, moved, mac)?.rename_mark,
          RENAME_NOTE,
          `${moved} is a note`,
        );
        assertEquals(new TextDecoder().decode(fresh.fakeVault.files.get(moved)), `note ${i}`);
      }
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(fresh.fakeVault.files.size, 20);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-reconciler - the mass-delete guard suppresses the whole pass, creates included",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, server, vaultId, stop } = await pair();
    try {
      // 20 of 20: with #601's default guard both conditions (20 files, > 25%) are met.
      const names = Array.from({ length: 20 }, (_, i) => `g${i}.md`);
      for (const [i, path] of names.entries()) A.fakeVault.write(path, `content ${i}`);
      await A.flushPending();
      assertEquals(liveHeadCount(server, vaultId), 20, "precondition: 20 live paths");

      const fresh = await restartWithDiskChange(A, server, () => {
        for (const path of names) removeSilently(A.fakeVault, path);
        writeSilently(A.fakeVault, "new.md", "created in the same pass");
      });
      await settleReconcile(fresh, server, vaultId);

      const mac = fresh.keys!.mac_key;
      for (const path of names) {
        const row = head(server, vaultId, path, mac)!;
        assertEquals(row.deleted, 0, `${path} still open: the pass waited`);
      }
      assertEquals(chain(server, vaultId, "new.md", mac).length, 0, "no create landed either");
      assertEquals(trashCount(server, vaultId), 0);
      assertEquals(liveHeadCount(server, vaultId), 20);
    } finally {
      await stop();
    }
  },
});
