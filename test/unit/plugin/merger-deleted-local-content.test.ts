import { assertEquals } from "@std/assert";
import { blake3Hex } from "../../../core/hash.ts";
import { chunk } from "../../../core/chunker.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion, type VersionRecord } from "../../../core/protocol.ts";
import { orchestrateMerge } from "../../../plugin/sync/merger.ts";
import { openStateDB, StateDB } from "../../../plugin/plumbing/state.ts";

// #590: a row can say "deleted" while the file is back on disk (a name renamed
// away and then reused, a re-created file). A tombstone head must not resolve as
// a no-op then: the bytes on disk are an edit and must be kept.

const DEVICE = "device-self";
const PATH = "n1.md";
const PATH_HASH = "hash-n1";

async function tombstone(keys: VaultKeys, version: number): Promise<ServerVersion> {
  const meta = { path: PATH, mtime: 1, size: 0, mime: "", plaintext_hash: "" };
  return {
    type: "server_version",
    vault_id: "v",
    seq: version,
    path_hash: PATH_HASH,
    parent_version: version - 1,
    enc_metadata: b64encode(await encryptMetadata(meta, keys, PATH_HASH)),
    chunk_hashes: [],
    deleted: true,
    device_id: "device-other",
    version,
  };
}

function makeDeps(
  keys: VaultKeys,
  state: StateDB,
  blobs: Map<string, Uint8Array> = new Map(),
  exists = (_path: string) => false,
) {
  const writes: Uint8Array[] = [];
  const commits: Array<{ merged: string; parent: number }> = [];
  const deps = {
    vault: {
      adapter: {
        writeBinary: (_path: string, data: Uint8Array) => {
          writes.push(new Uint8Array(data));
        },
        remove: async () => {},
        readBinary: () => Promise.resolve(new Uint8Array()),
        exists: (path: string) => exists(path),
      },
    },
    transport: {
      getBlob: (hash: string) => Promise.resolve(blobs.get(hash) ?? new Uint8Array()),
      getVersionChain: (): Promise<VersionRecord[]> => Promise.resolve([]),
    },
    keys,
    state,
    deviceId: DEVICE,
    deviceName: "Laptop",
    commitMerged: (_path: string, merged: Uint8Array, parent: number) => {
      commits.push({ merged: new TextDecoder().decode(merged), parent });
      return Promise.resolve();
    },
  };
  return { deps, writes, commits };
}

/** A row closed at version 1 (a rename-away or delete), file re-created on disk. */
function closedRow(state: StateDB): void {
  state.closeLocalRow(PATH, PATH_HASH, 1);
}

async function keysOf(): Promise<VaultKeys> {
  return await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
}

Deno.test({
  name: "merger-deleted-local-content - a tombstone head never no-ops over a file back on disk",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    closedRow(state);
    const { deps, writes, commits } = makeDeps(keys, state);
    const local = new TextEncoder().encode("head\nRN0-19\nbody\n");

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: 1,
        serverVersion: await tombstone(keys, 2),
      },
      deps,
    );

    assertEquals(result.kind, "clean", "the local edit wins over a tombstone, never a no-op");
    assertEquals(commits.length, 1, "the kept bytes must be committed so peers get them");
    assertEquals(commits[0].merged, "head\nRN0-19\nbody\n");
    assertEquals(commits[0].parent, 2);
    assertEquals(writes.length, 1);
    assertEquals(new TextDecoder().decode(writes[0]), "head\nRN0-19\nbody\n");
  },
});

Deno.test({
  name: "merger-deleted-local-content - both sides deleted with no bytes left stays a no-op",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    closedRow(state);
    const { deps, writes, commits } = makeDeps(keys, state);

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local: new Uint8Array(),
        localVersion: 1,
        serverVersion: await tombstone(keys, 2),
      },
      deps,
    );

    assertEquals(result.kind, "no_op");
    assertEquals(commits.length, 0);
    assertEquals(writes.length, 0, "a deleted file must not be re-created");
    assertEquals(state.getLocalFile(PATH)!.last_seen_version, 2);
    assertEquals(
      state.getLocalFile(PATH)!.deleted,
      true,
      "the row must stay closed, or the reconciler commits a spurious delete",
    );
  },
});

/** A live content version: what a peer committed while this row was closed. */
async function contentVersion(
  keys: VaultKeys,
  content: string,
  version: number,
): Promise<{ sv: ServerVersion; blobs: Map<string, Uint8Array> }> {
  const bytes = new TextEncoder().encode(content);
  const hashes: string[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (const c of chunk(bytes)) {
    const h = blake3Hex(c);
    hashes.push(h);
    blobs.set(h, await encryptChunk(c, keys, h));
  }
  const meta = {
    path: PATH,
    mtime: 1,
    size: bytes.length,
    mime: "text/markdown",
    plaintext_hash: blake3Hex(bytes),
  };
  return {
    sv: {
      type: "server_version",
      vault_id: "v",
      seq: version,
      path_hash: PATH_HASH,
      parent_version: version - 1,
      enc_metadata: b64encode(await encryptMetadata(meta, keys, PATH_HASH)),
      chunk_hashes: hashes,
      deleted: false,
      device_id: "device-other",
      version,
    },
    blobs,
  };
}

Deno.test({
  name: "merger-deleted-local-content - a closed row never drops the bytes it re-created",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    closedRow(state);
    const server = await contentVersion(keys, "head\nRN1-17\nbody\n", 2);
    const { deps, writes, commits } = makeDeps(keys, state, server.blobs, (p) => p === PATH);
    const local = new TextEncoder().encode("head\nRN0-19\nbody\n");

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: 1,
        serverVersion: server.sv,
      },
      deps,
    );

    // #589/#590: the row is closed (a delete or a rename away) and the file is back
    // on disk: that is a create against the peer's own commit. Neither side is the
    // file's ancestor, so both must survive: the local bytes in a conflict file.
    assertEquals(result.kind, "conflict_file", "the re-created bytes must not be overwritten");
    assertEquals(result.conflictPath !== undefined, true);
    assertEquals(new TextDecoder().decode(writes[0]), "head\nRN0-19\nbody\n");
    assertEquals(new TextDecoder().decode(writes[1]), "head\nRN1-17\nbody\n");
    assertEquals(
      commits.length,
      0,
      "the conflict file is committed by the reconciler, not the merge",
    );
  },
});

Deno.test({
  name: "merger-deleted-local-content - a stale read of a removed file is no re-creation",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    closedRow(state);
    const server = await contentVersion(keys, "head\nRN1-17\nbody\n", 2);
    // The adapter still answers a read for bytes it has already removed (mobile cache
    // lag): the bytes are not evidence the file is back, the file itself is absent.
    const { deps, writes, commits } = makeDeps(keys, state, server.blobs, () => false);

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local: new TextEncoder().encode("head\nstale-cached\nbody\n"),
        localVersion: 1,
        serverVersion: server.sv,
      },
      deps,
    );

    assertEquals(result.kind, "clean", "no re-creation: the server copy is the file");
    assertEquals(writes.length, 1, "one write, no conflict sibling");
    assertEquals(new TextDecoder().decode(writes[0]), "head\nRN1-17\nbody\n");
    assertEquals(commits.length, 0);
  },
});

Deno.test({
  name: "merger-deleted-local-content - a re-created empty file is a re-creation",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    closedRow(state);
    const server = await contentVersion(keys, "head\nRN1-17\nbody\n", 2);
    // Present on disk with no bytes: a create is still a create (only the content is
    // empty), so the peer's version may not simply take the name.
    const { deps, writes } = makeDeps(keys, state, server.blobs, (p) => p === PATH);

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local: new Uint8Array(0),
        localVersion: 1,
        serverVersion: server.sv,
      },
      deps,
    );

    assertEquals(result.kind, "conflict_file", "the empty create is kept, never overwritten");
    assertEquals(new TextDecoder().decode(writes[0]), "", "the re-created copy is the sibling");
    assertEquals(new TextDecoder().decode(writes[1]), "head\nRN1-17\nbody\n");
  },
});
