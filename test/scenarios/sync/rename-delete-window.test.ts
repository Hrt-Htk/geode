// #629: a rename whose new name is deleted inside the same debounce window
// (X → Y, then delete Y): nothing is ever written at Y, so X's marker names a name
// that never opens. The file's history then hangs off a dangling link and a peer's
// carried edit lands on a name no device will ever apply. The whole rename is
// cancelled: one plain delete of X, no link, and X's history sits in its trash entry.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestPlugin, type TestServer, waitFor } from "../../two-vault-driver.ts";
import { type FileMeta, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { decryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { HistoryWalk } from "../../../plugin/sync/history-fetch.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

type Row = { version: number; deleted: number; rename_mark: number; enc_metadata: Uint8Array };

function chain(server: TestServer, vaultId: string, path: string, macKey: Uint8Array): Row[] {
  return server.db
    .prepare(
      "SELECT version, deleted, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
    )
    .all(vaultId, hashPathHex(macKey, path)) as Row[];
}

/** A name's versions with their decrypted rename links, oldest first. */
async function links(
  server: TestServer,
  vaultId: string,
  path: string,
  keys: VaultKeys,
): Promise<Array<{ version: number; deleted: number; mark: number; meta: FileMeta }>> {
  const pathHash = hashPathHex(keys.mac_key, path);
  const out = [];
  for (const row of chain(server, vaultId, path, keys.mac_key)) {
    out.push({
      version: row.version,
      deleted: row.deleted,
      mark: row.rename_mark,
      meta: await decryptMetadata(row.enc_metadata, keys, pathHash),
    });
  }
  return out;
}

/** The trash rows the server holds, by path hash. */
function trashed(server: TestServer, vaultId: string): string[] {
  const rows = server.db
    .prepare("SELECT path_hash FROM trashed_heads WHERE vault_id = ?")
    .all(vaultId) as Array<{ path_hash: string }>;
  return rows.map((row) => row.path_hash).sort();
}

/** Every save History shows for `path`, newest name first. */
async function walkSegments(
  dev: { transport: unknown; keys: VaultKeys | null },
  path: string,
): Promise<Array<{ from: string | null; versions: number[] }>> {
  const keys = dev.keys!;
  const walk = new HistoryWalk(dev.transport as never, keys, hashPathHex(keys.mac_key, path));
  while (!walk.done) await walk.next();
  return walk.segments.map((segment) => ({
    from: segment.from,
    versions: segment.versions.map((row) => row.version),
  }));
}

function paths(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].sort();
}

function text(plugin: TestPlugin): string {
  return [...plugin.fakeVault.files.values()].map((data) => new TextDecoder().decode(data)).join(
    "\n",
  );
}

function read(plugin: TestPlugin, path: string): string {
  const data = plugin.fakeVault.files.get(path);
  return data ? new TextDecoder().decode(data) : "";
}

function conflictFiles(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].filter(isConflictPath);
}

function mapsEqual(a: TestPlugin, b: TestPlugin): boolean {
  const describe = (plugin: TestPlugin) =>
    [...plugin.fakeVault.files.entries()]
      .map(([path, data]) => `${path}\u0000${new TextDecoder().decode(data)}`)
      .sort()
      .join("\u0001");
  return describe(a) === describe(b);
}

/** Push both devices until their vaults are byte-identical. */
async function settle(a: TestPlugin, b: TestPlugin): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await a.pushNow();
    await b.pushNow();
    if (mapsEqual(a, b)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`devices did not converge: A=${paths(a)} B=${paths(b)}`);
}

Deno.test({
  name: "rename-delete-window - deleting the new name inside the window is one delete of X",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // Both the rename and the delete land in one debounce window: y.md never opens.
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.delete("y.md");
      await A.flushPending();
      await B.waitForDeleted("x.md");
      await settle(A, B);

      assertEquals(paths(A), [], "A holds nothing");
      assertEquals(paths(B), [], "B holds nothing");
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "y.md", keys.mac_key), [], "y.md never opened");
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(x.map((row) => [row.deleted, row.mark]), [[0, 0], [1, 0]], "X is one tombstone");
      assertEquals(x.at(-1)!.meta.renamed_to, undefined, "the tombstone links nowhere");
      assertEquals(
        trashed(server, vaultId),
        [hashPathHex(keys.mac_key, "x.md")].sort(),
        "X's trash entry is what keeps its history reachable",
      );
      assertEquals(await walkSegments(B, "x.md"), [
        { from: null, versions: [x[1].version, x[0].version] },
      ]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-delete-window - a chain deleted inside the window is one delete of the chain's start",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      A.fakeVault.delete("z.md");
      await A.flushPending();
      await B.waitForDeleted("x.md");
      await settle(A, B);

      assertEquals(paths(A), []);
      assertEquals(paths(B), []);
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "y.md", keys.mac_key), [], "y.md never opened");
      assertEquals(chain(server, vaultId, "z.md", keys.mac_key), [], "z.md never opened");
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(x.map((row) => [row.deleted, row.mark]), [[0, 0], [1, 0]]);
      assertEquals(x.at(-1)!.meta.renamed_to, undefined, "the tombstone links nowhere");
      assertEquals(trashed(server, vaultId), [hashPathHex(keys.mac_key, "x.md")].sort());
      assertEquals(await walkSegments(B, "x.md"), [
        { from: null, versions: [x[1].version, x[0].version] },
      ]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-delete-window - a peer's edit to X survives the rename-then-delete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // A renames and deletes while its queue is paused; B edits X in the meantime, so
      // A's close of the old name lands on a head that already moved.
      A.pause();
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.delete("y.md");
      A.eventHandler!.flushNow();
      B.fakeVault.write("x.md", "v1\npeer edit\n");
      await B.flushPending();
      await A.resume();
      await A.waitForIdle();
      await settle(A, B);

      assert(
        text(A).includes("peer edit") && text(B).includes("peer edit"),
        `the peer's edit survives on both: A=${JSON.stringify(text(A))} B=${
          JSON.stringify(text(B))
        }`,
      );
      // The tombstone lost to the peer's content head, so X is restored: a delete is
      // undone by a racing edit (#361), never a lost edit.
      assertEquals(read(A, "x.md"), "v1\npeer edit\n", "A keeps the peer's edit at X");
      assertEquals(read(B, "x.md"), "v1\npeer edit\n", "B keeps the peer's edit at X");
      assert(!A.fakeVault.fileExists("y.md"), "the deleted new name is not resurrected");
      assert(!B.fakeVault.fileExists("y.md"), "the deleted new name never opens on B");
      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "y.md", keys.mac_key), [], "y.md never opened");
      assertEquals(conflictFiles(A), conflictFiles(B), "no stray conflict artifact");
    } finally {
      await stop();
    }
  },
});

/** Hold the first commit matching `match` until `release()` is called. */
function holdCommit(
  plugin: TestPlugin,
  match: (req: { deleted?: boolean; rename_mark?: number }) => boolean,
): { release: () => void; held: Promise<void>; wasHeld: () => boolean } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  const send = plugin.transport!.commit.bind(plugin.transport!);
  plugin.transport!.commit = (req) => {
    if (!holding && match(req)) {
      holding = true;
      return gate.then(() => send(req));
    }
    return send(req);
  };
  return {
    release,
    held: new Promise((resolve) => {
      const poll = setInterval(() => {
        if (!holding) return;
        clearInterval(poll);
        resolve();
      }, 10);
    }),
    wasHeld: () => holding,
  };
}

Deno.test({
  name: "rename-delete-window - a delete queued behind an in-flight note keeps the links",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // The chain's final note is in flight when the user deletes the name it opens: the
      // queue cannot fold the two (an in-flight op is never replaced), so the delete
      // carries no link of its own and must not cancel the chain: the note lands first.
      const hold = holdCommit(A, (req) => req.deleted !== true && req.rename_mark === RENAME_NOTE);
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      A.eventHandler!.flushNow();
      await waitFor(hold.wasHeld, "the chain's note to be in flight");
      A.fakeVault.delete("z.md");
      A.eventHandler!.flushNow();
      hold.release();
      await A.waitForIdle();
      await settle(A, B);

      assertEquals(paths(A), [], "A holds nothing");
      assertEquals(paths(B), [], "B holds nothing");
      const keys = A.keys!;
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(
        x.map((row) => [row.deleted, row.mark, row.meta.renamed_to]),
        [[0, 0, undefined], [1, RENAME_MARKER, "z.md"]],
        "X's marker names the name the note opens",
      );
      assertEquals(
        chain(server, vaultId, "y.md", keys.mac_key),
        [],
        "the middle name never opened",
      );
      const z = await links(server, vaultId, "z.md", keys);
      assertEquals(
        z.map((row) => [row.deleted, row.mark, row.meta.renamed_from]),
        [[0, RENAME_NOTE, "x.md"], [1, 0, undefined]],
        "Z opened with its note and was then really deleted",
      );
      assertEquals(await walkSegments(B, "z.md"), [
        { from: "x.md", versions: [z[1].version, z[0].version] },
        { from: null, versions: [x[0].version] },
      ], "History on Z still reaches X's saves (a marker is a link, not a save)");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name:
    "rename-delete-window - a delete of the destination for an older generation is not this rename's close",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "x body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // y.md's name holds only a carried row (no version of its own), and the user deletes
      // that file: a plain delete, in flight while the rename onto the name resolves. It
      // carries no rename link, so it is not the rename closing its own new name.
      const keys = A.keys!;
      A.fakeVault.files.set("y.md", new TextEncoder().encode("old y\n"));
      A.fakeVault.mtimes.set("y.md", Date.now());
      A.state!.upsertLocalFile({
        path: "y.md",
        path_hash: hashPathHex(keys.mac_key, "y.md"),
        size: 6,
        mtime: Date.now(),
        plaintext_hash: "",
        last_seen_version: 0,
        chunk_hashes: [],
        deleted: false,
      });
      const hold = holdCommit(A, (req) => req.deleted === true && !req.rename_mark);
      A.fakeVault.delete("y.md");
      A.eventHandler!.flushNow();
      await waitFor(hold.wasHeld, "the older generation's delete to be in flight");
      A.fakeVault.rename("x.md", "y.md");
      A.eventHandler!.flushNow();
      hold.release();
      await A.waitForIdle();
      await settle(A, B);

      assertEquals(paths(A), ["y.md"], "the file ends at the name it was renamed to");
      assertEquals(paths(B), ["y.md"]);
      assertEquals(read(B, "y.md"), "x body\n");
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(
        x.map((row) => [row.deleted, row.mark, row.meta.renamed_to]),
        [[0, 0, undefined], [1, RENAME_MARKER, "y.md"]],
        "X's marker stands: something else deleted the name",
      );
      const y = await links(server, vaultId, "y.md", keys);
      assertEquals(
        y.map((row) => [row.deleted, row.mark, row.meta.renamed_from]),
        [[1, 0, undefined], [0, RENAME_NOTE, "x.md"]],
        "the older generation's tombstone, then the note that opens the name",
      );
    } finally {
      await stop();
    }
  },
});
