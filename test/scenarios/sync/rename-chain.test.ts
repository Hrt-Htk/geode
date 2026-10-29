// #615: a rename chain made inside one debounce window (X → Y → Z) must write one
// link, not one per hop: nothing is ever written at the middle name, so the marker
// at X has to name the final name and the final note has to link straight back to X.

import { assert, assertEquals } from "@std/assert";
import { pair, type TestServer } from "../../two-vault-driver.ts";
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

/** The cap is the marker's version once its ack landed, or 0 ("the newest marker on the
 * old name's head page") when this device had not seen it yet: both are inside the
 * generation the note points at. */
function assertCappedAtMarker(cap: number | undefined, markerVersion: number): void {
  assert(
    cap === 0 || cap === markerVersion,
    `cap ${cap} is inside the marker's generation (marker ${markerVersion})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function content(plugin: { fakeVault: { files: Map<string, Uint8Array> } }, path: string): string {
  const body = plugin.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : "";
}

function conflictFiles(plugin: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...plugin.fakeVault.files.keys()].filter(isConflictPath);
}

Deno.test({
  name: "rename-chain - a chain inside one debounce writes one link and the walk reaches X",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      A.fakeVault.write("x.md", "v1\nv2\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // Both hops inside one debounce window: y.md never reaches the server.
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      await A.flushPending();
      await B.waitForVersion("z.md");
      await B.waitForDeleted("x.md");
      await A.waitForConvergence(B, "z.md");

      assertEquals(paths(A), ["z.md"], "only the final name survives on A");
      assertEquals(paths(B), ["z.md"], "the middle name never appears on B");
      assertEquals(content(B, "z.md"), "v1\nv2\n");
      assertEquals(conflictFiles(A), []);
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(
        chain(server, vaultId, "y.md", keys.mac_key),
        [],
        "no phantom row at the middle name",
      );

      const x = await links(server, vaultId, "x.md", keys);
      const marker = x.at(-1)!;
      assertEquals([marker.deleted, marker.mark, marker.meta.renamed_to], [
        1,
        RENAME_MARKER,
        "z.md",
      ]);

      const z = await links(server, vaultId, "z.md", keys);
      assertEquals(z.map((row) => [row.deleted, row.mark]), [[0, RENAME_NOTE]]);
      assertEquals(
        z[0].meta.renamed_from,
        "x.md",
        "the note links straight back to the chain's start",
      );
      assertEquals(
        z[0].meta.renamed_from_version,
        marker.version,
        "capped at the marker it points at",
      );

      assertEquals(await walkSegments(B, "z.md"), [
        { from: "x.md", versions: [z[0].version] },
        { from: null, versions: [x[1].version, x[0].version] },
      ], "History on Z reaches X's saves");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - an edit between the hops reaches Z and keeps the link",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.write("y.md", "v1 edited\n");
      A.fakeVault.rename("y.md", "z.md");
      await A.flushPending();
      await B.waitForVersion("z.md");
      await B.waitForDeleted("x.md");
      await A.waitForConvergence(B, "z.md");

      assertEquals(paths(B), ["z.md"]);
      assertEquals(content(A, "z.md"), "v1 edited\n", "the edit made at the middle name survives");
      assertEquals(content(B, "z.md"), "v1 edited\n");
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "y.md", keys.mac_key), []);
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(x.at(-1)!.meta.renamed_to, "z.md");
      assertEquals(await walkSegments(B, "z.md"), [
        { from: "x.md", versions: [1] },
        { from: null, versions: [1] },
      ], "both the edit at Z and X's save are in the window");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - a three-hop chain links only its two ends",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      A.fakeVault.rename("z.md", "w.md");
      await A.flushPending();
      await B.waitForVersion("w.md");
      await B.waitForDeleted("x.md");
      await A.waitForConvergence(B, "w.md");

      assertEquals(paths(A), ["w.md"]);
      assertEquals(paths(B), ["w.md"]);
      assertEquals(content(B, "w.md"), "body\n");

      const keys = A.keys!;
      assertEquals(
        chain(server, vaultId, "y.md", keys.mac_key),
        [],
        "no row at the first middle name",
      );
      assertEquals(
        chain(server, vaultId, "z.md", keys.mac_key),
        [],
        "no row at the second middle name",
      );
      assertEquals((await links(server, vaultId, "x.md", keys)).at(-1)!.meta.renamed_to, "w.md");
      assertEquals((await links(server, vaultId, "w.md", keys))[0].meta.renamed_from, "x.md");
      assertEquals(await walkSegments(B, "w.md"), [
        { from: "x.md", versions: [1] },
        { from: null, versions: [1] },
      ]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - renamed away and back inside one debounce writes no link",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "x.md");
      await A.flushPending();
      await A.waitForIdle();

      assertEquals(paths(A), ["x.md"], "the file never left");
      assertEquals(paths(B), ["x.md"]);
      assertEquals(content(B, "x.md"), "body\n");
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "y.md", keys.mac_key), [], "no phantom middle name");
      assertEquals(
        (await links(server, vaultId, "x.md", keys)).map((
          row,
        ) => [row.version, row.deleted, row.mark]),
        [[1, 0, 0]],
        "x.md keeps its own single version: no marker and no returning note",
      );
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - a ping-pong chain lands on the name the file occupies",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "v1\n");
      await A.flushPending();
      A.fakeVault.write("x.md", "v1\nv2\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // x -> y -> z -> y: the chain revisits y, so y is where the file ends up.
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      A.fakeVault.rename("z.md", "y.md");
      await A.flushPending();
      await B.waitForVersion("y.md");
      await A.waitForConvergence(B, "y.md");

      assertEquals(paths(A), ["y.md"], "the file lands on the revisited name");
      assertEquals(paths(B), ["y.md"]);
      assertEquals(content(B, "y.md"), "v1\nv2\n");
      assertEquals(conflictFiles(B), []);

      const keys = A.keys!;
      assertEquals(chain(server, vaultId, "z.md", keys.mac_key), [], "z never opened");
      const x = await links(server, vaultId, "x.md", keys);
      const marker = x.at(-1)!;
      assertEquals(
        [marker.deleted, marker.mark, marker.meta.renamed_to],
        [1, RENAME_MARKER, "y.md"],
        "the marker names the name the file actually occupies",
      );
      const y = await links(server, vaultId, "y.md", keys);
      assertEquals(y.map((row) => [row.deleted, row.mark]), [[0, RENAME_NOTE]]);
      assertEquals(y[0].meta.renamed_from, "x.md", "the note links back to the chain's start");
      assertCappedAtMarker(y[0].meta.renamed_from_version, marker.version);

      assertEquals(await walkSegments(B, "y.md"), [
        { from: "x.md", versions: [y[0].version] },
        { from: null, versions: [x[1].version, x[0].version] },
      ], "History on Y reaches X's saves");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - a retried marker still names the chain's end",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      A.fakeVault.write("x.md", "body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      // Queue the whole chain, then let the marker's first commit fail: the retry runs
      // after the middle's ops are gone, so it has to remember where the chain ended.
      A.pause();
      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      A.eventHandler!.flushNow();
      const send = A.transport!.commit.bind(A.transport!);
      let failed = false;
      A.transport!.commit = (req) => {
        if (!failed && req.deleted && req.rename_mark === 1) {
          failed = true;
          return Promise.reject(new Error("transient failure"));
        }
        return send(req);
      };
      await A.resume();
      await sleep(400);
      // A later pass retries the requeued marker.
      A.fakeVault.write("side.md", "side\n");
      await A.flushPending();
      await A.waitForIdle();
      await B.waitForVersion("z.md");
      await A.waitForConvergence(B, "z.md");

      assert(failed, "the marker's first attempt failed");
      const keys = A.keys!;
      assertEquals(
        chain(server, vaultId, "y.md", keys.mac_key),
        [],
        "no phantom row at the middle name",
      );
      const x = await links(server, vaultId, "x.md", keys);
      assertEquals(
        [x.at(-1)!.deleted, x.at(-1)!.mark, x.at(-1)!.meta.renamed_to],
        [1, RENAME_MARKER, "z.md"],
        "the retried marker names the chain's end, not the middle name",
      );
      const z = await links(server, vaultId, "z.md", keys);
      assertEquals(z[0].meta.renamed_from, "x.md");
      assertEquals(await walkSegments(B, "z.md"), [
        { from: "x.md", versions: [z[0].version] },
        { from: null, versions: [x[0].version] },
      ]);
      assertEquals(paths(B), ["side.md", "z.md"], "the middle name never appears");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "rename-chain - a chain through a reused name leaves that name's own history alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      // y.md existed before, so its name carries an older generation.
      A.fakeVault.write("y.md", "old y\n");
      await A.flushPending();
      await B.waitForVersion("y.md");
      await A.fakeVault.delete("y.md");
      await A.flushPending();
      await B.waitForDeleted("y.md");

      A.fakeVault.write("x.md", "x body\n");
      await A.flushPending();
      await B.waitForVersion("x.md");

      const keys = A.keys!;
      const before = chain(server, vaultId, "y.md", keys.mac_key).map((row) => row.version);

      A.fakeVault.rename("x.md", "y.md");
      A.fakeVault.rename("y.md", "z.md");
      await A.flushPending();
      await B.waitForVersion("z.md");
      await A.waitForConvergence(B, "z.md");

      assertEquals(paths(B), ["z.md"]);
      assertEquals(content(B, "z.md"), "x body\n");
      assertEquals(
        chain(server, vaultId, "y.md", keys.mac_key).map((row) => row.version),
        before,
        "nothing new is written at the reused middle name",
      );
      assertEquals((await links(server, vaultId, "x.md", keys)).at(-1)!.meta.renamed_to, "z.md");
      assertEquals(await walkSegments(B, "z.md"), [
        { from: "x.md", versions: [1] },
        { from: null, versions: [1] },
      ], "the reused name's older generation is not joined to this file");
      assert(!B.fakeVault.fileExists("y.md"), "the reused name is not resurrected");
    } finally {
      await stop();
    }
  },
});
