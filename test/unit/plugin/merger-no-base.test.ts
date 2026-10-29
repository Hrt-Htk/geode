import { assertEquals } from "@std/assert";
import { blake3Hex } from "../../../core/hash.ts";
import { chunk } from "../../../core/chunker.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion, type VersionRecord } from "../../../core/protocol.ts";
import { orchestrateMerge } from "../../../plugin/sync/merger.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

// #549: no local-files.json row (lost on a kill inside the persist window) means
// localVersion is null. The merger must fall back to this device's newest version
// in the server chain (VersionRecord.device_id) as the base: head is ours → commit
// local as the next version; base further back → 3-way merge; device never
// uploaded → conflict file, as today.

const DEVICE = "device-self";
const OTHER = "device-other";

async function makeVersion(
  keys: VaultKeys,
  path: string,
  pathHash: string,
  version: number,
  deviceId: string,
  content: string,
  parent: number,
): Promise<{ sv: ServerVersion; rec: VersionRecord; blobs: Map<string, Uint8Array> }> {
  const bytes = new TextEncoder().encode(content);
  const hashes: string[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (const c of chunk(bytes)) {
    const h = blake3Hex(c);
    hashes.push(h);
    blobs.set(h, await encryptChunk(c, keys, h));
  }
  const meta = {
    path,
    mtime: 1,
    size: bytes.length,
    mime: "text/markdown",
    plaintext_hash: blake3Hex(bytes),
  };
  const encMeta = b64encode(await encryptMetadata(meta, keys, pathHash));
  const sv: ServerVersion = {
    type: "server_version",
    vault_id: "v",
    seq: version,
    path_hash: pathHash,
    parent_version: parent,
    enc_metadata: encMeta,
    chunk_hashes: hashes,
    deleted: false,
    device_id: deviceId,
    version,
  };
  const rec: VersionRecord = {
    version,
    parent,
    chunk_hashes: hashes,
    enc_metadata: encMeta,
    compacted_range: null,
    path_ciphertext: null,
    device_id: deviceId,
  };
  return { sv, rec, blobs };
}

function makeDeps(
  keys: VaultKeys,
  chain: VersionRecord[],
  blobs: Map<string, Uint8Array>,
) {
  const writes: Array<{ path: string; data: Uint8Array }> = [];
  let committed: { path: string; merged: Uint8Array; parent: number } | null = null;
  const state = openStateDB();
  const deps = {
    vault: {
      adapter: {
        writeBinary: (path: string, data: Uint8Array) => {
          writes.push({ path, data: new Uint8Array(data) });
          return Promise.resolve();
        },
        remove: async () => {},
        readBinary: () => Promise.resolve(new Uint8Array()),
        exists: () => Promise.resolve(false),
      },
    },
    transport: {
      getBlob: (h: string) => Promise.resolve(blobs.get(h) ?? new Uint8Array()),
      getVersionChain: () => Promise.resolve(chain),
    },
    keys,
    state,
    deviceId: DEVICE,
    deviceName: "Laptop",
    commitMerged: (path: string, merged: Uint8Array, parentVersion: number) => {
      committed = { path, merged: new Uint8Array(merged), parent: parentVersion };
      return Promise.resolve();
    },
  };
  return { deps, writes, committed: () => committed, state };
}

const PATH = "note.md";
const PATH_HASH = "h";

Deno.test({
  name: "merger-no-base - head committed by this device → commit local as next version",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const head = await makeVersion(keys, PATH, PATH_HASH, 3, DEVICE, "server v3\n", 2);
    const { deps, writes, committed, state } = makeDeps(keys, [head.rec], head.blobs);

    const local = new TextEncoder().encode("local edit\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "clean", "no conflict file when the head is this device's own");
    assertEquals(committed()!.parent, 3, "commit parent is the server head");
    assertEquals(
      new TextDecoder().decode(committed()!.merged),
      "local edit\n",
      "commits the local content",
    );
    assertEquals(
      writes.some((w) => isConflictPath(w.path)),
      false,
      "no conflict file written",
    );
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - base further back (this device) → clean 3-way merge",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const base = await makeVersion(keys, PATH, PATH_HASH, 1, DEVICE, "a\nb\nc\n", 0);
    const head = await makeVersion(keys, PATH, PATH_HASH, 2, OTHER, "a\nb2\nc\n", 1);
    const { deps, writes, committed, state } = makeDeps(
      keys,
      [head.rec, base.rec],
      new Map([...head.blobs, ...base.blobs]),
    );

    const local = new TextEncoder().encode("a2\nb\nc\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "clean", "non-overlapping edits merge cleanly");
    assertEquals(
      new TextDecoder().decode(committed()!.merged),
      "a2\nb2\nc\n",
      "3-way merge over this device's last version",
    );
    assertEquals(committed()!.parent, 2, "commit parent is the server head");
    assertEquals(writes.some((w) => isConflictPath(w.path)), false, "no conflict file");
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - base further back (this device), overlapping edits → conflict file",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const base = await makeVersion(keys, PATH, PATH_HASH, 1, DEVICE, "a\nb\nc\n", 0);
    const head = await makeVersion(keys, PATH, PATH_HASH, 2, OTHER, "a\nb2\nc\n", 1);
    const { deps, writes, state } = makeDeps(
      keys,
      [head.rec, base.rec],
      new Map([...head.blobs, ...base.blobs]),
    );

    const local = new TextEncoder().encode("a\nb3\nc\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "conflict_file", "overlapping edits surface a conflict file");
    const conflictWrite = writes.find((w) => isConflictPath(w.path));
    assertEquals(Boolean(conflictWrite), true, "conflict file written");
    assertEquals(
      new TextDecoder().decode(conflictWrite!.data),
      "a\nb3\nc\n",
      "conflict file holds the local copy",
    );
    const pathWrite = writes.find((w) => w.path === PATH);
    assertEquals(
      new TextDecoder().decode(pathWrite!.data),
      "a\nb2\nc\n",
      "path gets the server copy",
    );
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - this device never uploaded the file → conflict file",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const head = await makeVersion(keys, PATH, PATH_HASH, 1, OTHER, "server only\n", 0);
    const { deps, writes, state } = makeDeps(keys, [head.rec], head.blobs);

    const local = new TextEncoder().encode("local only\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "conflict_file", "no common ancestor → conflict file, as today");
    assertEquals(writes.some((w) => isConflictPath(w.path)), true, "conflict file written");
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - local equals own base, head advanced → adopt head, no duplicate commit",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const v1 = await makeVersion(keys, PATH, PATH_HASH, 1, DEVICE, "base\n", 0);
    const v2 = await makeVersion(keys, PATH, PATH_HASH, 2, OTHER, "base\nremote\n", 1);
    const blobs = new Map([...v1.blobs, ...v2.blobs]);
    const { deps, writes, committed, state } = makeDeps(keys, [v2.rec, v1.rec], blobs);

    // Local disk still holds exactly our v1 content; the server head is the
    // other device's v2. The normal merge (base == local) yields the server's
    // content: it is written to disk with NO commit (a commit would be the
    // #493/#549 duplicate storm; a no_op would leave stale text on disk).
    const local = new TextEncoder().encode("base\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: v2.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "clean", "normal merge over the own base, not a no_op shortcut");
    assertEquals(committed(), null, "no extra commit: merged content equals the server head");
    const pathWrite = writes.find((w) => w.path === PATH);
    assertEquals(
      pathWrite ? new TextDecoder().decode(pathWrite.data) : null,
      "base\nremote\n",
      "disk ends with the server's content",
    );
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - identical content is still a no_op",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const head = await makeVersion(keys, PATH, PATH_HASH, 3, DEVICE, "same content\n", 2);
    const { deps, committed, state } = makeDeps(keys, [head.rec], head.blobs);

    const local = new TextEncoder().encode("same content\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "no_op", "identical content stays a no_op");
    assertEquals(committed(), null, "no commit");
    state.close();
  },
});

Deno.test({
  name:
    "merger-no-base - this device's newest version is a delete → conflict file, no integrity error",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const tombMeta = { path: PATH, mtime: 1, size: 0, mime: "", plaintext_hash: "" };
    const tomb: VersionRecord = {
      version: 1,
      parent: 0,
      chunk_hashes: [],
      enc_metadata: b64encode(await encryptMetadata(tombMeta, keys, PATH_HASH)),
      compacted_range: null,
      path_ciphertext: null,
      device_id: DEVICE,
    };
    const head = await makeVersion(keys, PATH, PATH_HASH, 2, OTHER, "recreated elsewhere\n", 1);
    const { deps, writes, state } = makeDeps(keys, [head.rec, tomb], head.blobs);

    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local: new TextEncoder().encode("recreated here\n"),
        localVersion: null,
        serverVersion: head.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "conflict_file", "a delete is no merge base");
    assertEquals(writes.some((w) => isConflictPath(w.path)), true, "conflict file written");
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - a rename-carried edit: the note equals the carried base → local wins",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const note = await makeVersion(keys, PATH, PATH_HASH, 1, OTHER, "base\n", 0);
    const { deps, writes, committed, state } = makeDeps(keys, [note.rec], note.blobs);
    // #583: the edit was carried across a rename: the row has no version on this
    // path (0) but keeps the hash it was made against.
    state.upsertLocalFile({
      path: PATH,
      path_hash: PATH_HASH,
      size: 5,
      mtime: 1,
      plaintext_hash: blake3Hex(new TextEncoder().encode("base\n")),
      last_seen_version: 0,
      chunk_hashes: [],
    });

    const local = new TextEncoder().encode("base\nlocal edit\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: note.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "clean", "the note adds nothing over the carried base");
    assertEquals(
      new TextDecoder().decode(committed()!.merged),
      "base\nlocal edit\n",
      "the carried edit wins",
    );
    assertEquals(writes.some((w) => isConflictPath(w.path)), false, "no conflict file");
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - a rename-carried edit: the note changed too → both kept",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    const note = await makeVersion(keys, PATH, PATH_HASH, 1, OTHER, "one\ntwo\nthree A\n", 0);
    const { deps, writes, state } = makeDeps(keys, [note.rec], note.blobs);
    state.upsertLocalFile({
      path: PATH,
      path_hash: PATH_HASH,
      size: 14,
      mtime: 1,
      plaintext_hash: blake3Hex(new TextEncoder().encode("one\ntwo\nthree\n")),
      last_seen_version: 0,
      chunk_hashes: [],
    });

    const local = new TextEncoder().encode("one B\ntwo\nthree\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        serverVersion: note.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "conflict_file", "no base content to merge over: keep both");
    assertEquals(
      new TextDecoder().decode(writes.find((w) => isConflictPath(w.path))!.data),
      "one B\ntwo\nthree\n",
      "the carried edit is kept in the conflict file",
    );
    assertEquals(
      new TextDecoder().decode(writes.find((w) => w.path === PATH)!.data),
      "one\ntwo\nthree A\n",
      "the note's content lands at the path",
    );
    state.close();
  },
});

Deno.test({
  name: "merger-no-base - a carried row never uses this device's own version as base",
  sanitizeResources: false,
  async fn() {
    const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
    // This path was used by this device before (recycled name): the #549 fallback
    // would pick its old version as the base: wrong for a carried rename edit.
    const own = await makeVersion(keys, PATH, PATH_HASH, 1, DEVICE, "ancient\n", 0);
    const note = await makeVersion(keys, PATH, PATH_HASH, 2, OTHER, "base\n", 1);
    const { deps, committed, writes, state } = makeDeps(
      keys,
      [note.rec, own.rec],
      new Map([...note.blobs, ...own.blobs]),
    );
    state.upsertLocalFile({
      path: PATH,
      path_hash: PATH_HASH,
      size: 5,
      mtime: 1,
      plaintext_hash: blake3Hex(new TextEncoder().encode("base\n")),
      last_seen_version: 0,
      chunk_hashes: [],
    });

    const local = new TextEncoder().encode("base\ncarried edit\n");
    const result = await orchestrateMerge(
      {
        pathHash: PATH_HASH,
        path: PATH,
        mime: "text/markdown",
        local,
        localVersion: null,
        carried: true,
        serverVersion: note.sv,
      },
      deps as never,
    );

    assertEquals(result.kind, "clean", "noBaseOutcome: the note adds nothing over the base");
    assertEquals(
      new TextDecoder().decode(committed()!.merged),
      "base\ncarried edit\n",
      "the carried edit wins: not a merge over the ancient version",
    );
    assertEquals(writes.some((w) => isConflictPath(w.path)), false);
    state.close();
  },
});
