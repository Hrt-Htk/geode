import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { chunk } from "../../../core/chunker.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, RENAME_MARKER, type ServerVersion } from "../../../core/protocol.ts";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { openStateDB, StateDB } from "../../../plugin/plumbing/state.ts";

// #590: device A renames a note to n1.md and commits it; device B creates its own
// n1.md a moment earlier and the reconciler has not queued it yet (no state row).
// A's head must not be written over B's file: the bytes on disk are an edit.

const PATH = "n1.md";

async function contentVersion(
  keys: VaultKeys,
  content: string,
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
  const sv: ServerVersion = {
    type: "server_version",
    vault_id: "v",
    seq: 9,
    path_hash: "hash-n1",
    parent_version: 1,
    enc_metadata: b64encode(await encryptMetadata(meta, keys, "hash-n1")),
    chunk_hashes: hashes,
    deleted: false,
    device_id: "device-other",
    version: 2,
  };
  return { sv, blobs };
}

type Disk = (path: string) => string | null;

function makeDeps(
  keys: VaultKeys,
  state: StateDB,
  disk: Disk,
  marked: string[],
  blobs: Map<string, Uint8Array>,
) {
  const writes: string[] = [];
  const reads: string[] = [];
  const stats: string[] = [];
  const deps: ApplyDeps = {
    pendingRenameTarget: () => undefined,
    vault: {
      adapter: {
        stat: (path: string) => {
          stats.push(path);
          return Promise.resolve(disk(path) === null ? null : { size: 1, mtime: 1 });
        },
        readBinary: (path: string) => {
          reads.push(path);
          const body = disk(path);
          if (body === null) return Promise.reject(new Error("ENOENT"));
          return Promise.resolve(new TextEncoder().encode(body));
        },
        writeBinary: (_path: string, data: Uint8Array) => {
          writes.push(new TextDecoder().decode(data));
          return Promise.resolve();
        },
        remove: async () => {},
      },
    },
    state,
    keys,
    getBlob: (h: string) => Promise.resolve(blobs.get(h) ?? new Uint8Array()),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: (path: string) => marked.push(path),
    myDeviceId: "device-self",
    suppressSelfWrite: () => {},
  };
  return { deps, writes, reads, stats };
}

/** A rename marker: the server closed `from`, the note's path is `to`. */
async function markerVersion(
  keys: VaultKeys,
  from: string,
  to: string,
): Promise<ServerVersion> {
  const meta = {
    path: from,
    renamed_to: to,
    mtime: 1,
    size: 0,
    mime: "",
    plaintext_hash: "",
  };
  return {
    type: "server_version",
    vault_id: "v",
    seq: 4,
    path_hash: hashPathHex(keys.mac_key, from),
    parent_version: 1,
    enc_metadata: b64encode(await encryptMetadata(meta, keys, hashPathHex(keys.mac_key, from))),
    chunk_hashes: [],
    deleted: true,
    rename_mark: RENAME_MARKER,
    device_id: "device-other",
    version: 2,
  };
}

async function keysOf(): Promise<VaultKeys> {
  return await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
}

Deno.test({
  name: "apply-untracked-local-create - a peer's head never overwrites an untracked local create",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    const marked: string[] = [];
    const version = await contentVersion(keys, "head\nRN1-17\nbody\n");
    const { deps, writes } = makeDeps(
      keys,
      state,
      () => "head\nRN0-19\nbody\n",
      marked,
      version.blobs,
    );

    await applyVersion(version.sv, deps);

    assertEquals(writes, [], "the local file's bytes must stay on disk");
    assertEquals(marked, [PATH], "the file is promoted to a tracked local edit to merge");
    assertEquals(
      state.getLocalFile(PATH),
      null,
      "no row: the reconciler commits it as a create so it conflicts and merges",
    );
  },
});

Deno.test({
  name: "apply-untracked-local-create - a closed row does not stay deleted over a re-created file",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    state.closeLocalRow(PATH, "hash-n1", 1);
    const marked: string[] = [];
    const version = await contentVersion(keys, "head\nRN1-17\nbody\n");
    const { deps, writes } = makeDeps(
      keys,
      state,
      () => "head\nRN0-19\nbody\n",
      marked,
      version.blobs,
    );

    await applyVersion(version.sv, deps);

    assertEquals(writes, [], "the local file's bytes must stay on disk");
    assertEquals(marked, [PATH]);
    assertEquals(
      state.getLocalFile(PATH)!.deleted,
      false,
      "a deleted row would let a later merge take the server's side",
    );
  },
});

Deno.test({
  name:
    "apply-untracked-local-create - an untracked file that already matches the head applies normally",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    const marked: string[] = [];
    const version = await contentVersion(keys, "head\nRN1-17\nbody\n");
    const { deps, writes } = makeDeps(
      keys,
      state,
      () => "head\nRN1-17\nbody\n",
      marked,
      version.blobs,
    );

    await applyVersion(version.sv, deps);

    assertEquals(marked, []);
    assertEquals(state.getLocalFile(PATH)!.last_seen_version, 2);
    assertEquals(writes.length, 1, "identical content is written through, as before");
  },
});

Deno.test({
  name:
    "apply-untracked-local-create - a taken rename destination keeps the old name's bytes tracked",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    const marked: string[] = [];
    const disk = (path: string) => {
      if (path === "n0.md") return "head\nkept-bytes\n";
      if (path === "n1.md") return "taken by the peer\n";
      return null;
    };
    const { deps, writes } = makeDeps(keys, state, disk, marked, new Map());

    await applyVersion(await markerVersion(keys, "n0.md", "n1.md"), deps);

    // #583: the renamed-away name is never resurrected: the bytes are kept next to
    // the taken destination as a conflict file (#590, and tracked, so a rebuild keeps
    // it instead of pruning it).
    assertEquals(writes, ["head\nkept-bytes\n"], "the kept bytes survive as a conflict file");
    assertEquals(marked.length, 1, "the kept file is a local edit: a rebuild must not prune it");
    assertEquals(marked[0].startsWith("n1 (conflict") && marked[0].endsWith(".md"), true);
    assertEquals(marked.includes("n0.md"), false, "the closed name is never re-committed");
    assertEquals(state.getLocalFile("n0.md")!.deleted, true);
    assertEquals(state.getLocalFile("n0.md")!.last_seen_version, 2);
  },
});

Deno.test({
  name: "apply-untracked-local-create - an absent file costs a stat, never a full read",
  sanitizeResources: false,
  async fn() {
    const keys = await keysOf();
    const state = openStateDB();
    const marked: string[] = [];
    const version = await contentVersion(keys, "head\nRN1-17\nbody\n");
    const { deps, reads, stats, writes } = makeDeps(keys, state, () => null, marked, version.blobs);

    await applyVersion(version.sv, deps);

    assertEquals(stats, [PATH], "presence is checked first");
    assertEquals(reads, [], "a missing file is never read (join/catch-up reads every path)");
    assertEquals(writes, ["head\nRN1-17\nbody\n"]);
    assertEquals(marked, []);
  },
});
