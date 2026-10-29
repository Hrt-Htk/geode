import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  decryptChunk,
  decryptMetadata,
  decryptPath,
  deriveKeys,
  encryptChunk,
  encryptMetadata,
  encryptPath,
  VaultKeys,
} from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";
import {
  b64decode,
  b64encode,
  type FileMeta,
  type HeadRecord,
  type VersionRecord,
} from "../../../core/protocol.ts";
import { HttpStatusError } from "../../../plugin/plumbing/provisioning-client.ts";
import {
  buildWorkList,
  type RekeyClient,
  type RekeyCursor,
  type RekeyCursorStore,
  type RekeyTrashEntry,
  rewriteTrashHead,
  rewriteVersionRow,
  runRekey,
} from "../../../plugin/sync/rekey-run.ts";

const FAST = { ops: 1, mem: 8192 };
const SALT = new Uint8Array(16).fill(7);

function keys(passphrase: string): Promise<VaultKeys> {
  return deriveKeys(passphrase, SALT, { opsLimit: FAST.ops, memLimit: FAST.mem });
}

function head(pathHash: string, version: number): HeadRecord {
  return {
    path_hash: pathHash,
    version,
    seq: version,
    enc_metadata: "",
    chunk_hashes: [],
    deleted: false,
    path_ciphertext: null,
    rename_mark: 0,
  };
}

function record(
  opts: Partial<VersionRecord> & { path_hash: string; version: number },
): VersionRecord {
  return {
    parent: null,
    seq: opts.version,
    chunk_hashes: [],
    enc_metadata: "",
    compacted_range: null,
    path_ciphertext: null,
    device_id: "dev",
    created_at: 1,
    deleted: 0,
    rename_mark: 0,
    ...opts,
  };
}

function memoryCursor(): RekeyCursorStore & { current: RekeyCursor | null } {
  const store: { current: RekeyCursor | null } = { current: null };
  return {
    get current() {
      return store.current;
    },
    load: () => store.current,
    save: (c: RekeyCursor) => {
      store.current = c;
    },
    clear: () => {
      store.current = null;
    },
  };
}

const C1 = "c1".repeat(32);
const C2 = "c2".repeat(32);
const C3 = "c3".repeat(32);

class FakeClient implements RekeyClient {
  blobs = new Map<string, Uint8Array>();
  putCount = 0;
  rowBatches: Array<{ versions: number; trash: number }> = [];
  started = 0;
  registered = 0;
  switched = 0;
  chain: VersionRecord[];
  constructor(chain: VersionRecord[]) {
    this.chain = chain;
  }
  heads(): Promise<HeadRecord[]> {
    return Promise.resolve(this.chain.map((r) => head(r.path_hash, r.version)));
  }
  versionChain(): Promise<VersionRecord[]> {
    return Promise.resolve(this.chain);
  }
  trash(): Promise<RekeyTrashEntry[]> {
    return Promise.resolve([]);
  }
  getBlob(hash: string): Promise<Uint8Array> {
    const b = this.blobs.get(hash);
    return b ? Promise.resolve(b) : Promise.reject(new Error(`no blob ${hash}`));
  }
  putBlob(hash: string, body: Uint8Array): Promise<void> {
    this.putCount++;
    this.blobs.set(hash, body);
    return Promise.resolve();
  }
  registerAuth(): Promise<void> {
    this.registered++;
    return Promise.resolve();
  }
  startSession(): Promise<void> {
    this.started++;
    return Promise.resolve();
  }
  status(): Promise<{ mode: null }> {
    return Promise.resolve({ mode: null });
  }
  postRows(versions: unknown[], trash: unknown[]): Promise<void> {
    this.rowBatches.push({ versions: versions.length, trash: trash.length });
    return Promise.resolve();
  }
  switch(): Promise<void> {
    this.switched++;
    return Promise.resolve();
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("buildWorkList: deterministic order, unique chunks, trash chunks included", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);
  const heads = [head(b, 1), head(a, 2)];
  const chains: Record<string, VersionRecord[]> = {
    [a]: [
      record({ path_hash: a, version: 2, chunk_hashes: [C2, C1] }),
      record({ path_hash: a, version: 1, chunk_hashes: [C1] }),
    ],
    [b]: [record({ path_hash: b, version: 1, chunk_hashes: [C3] })],
  };
  const trash = [
    {
      path_hash: c,
      trashed_at: 1,
      deleted_by_device: "d",
      head_json: JSON.stringify({ chunk_hashes: [C3, C2] }),
    },
  ];
  const work = buildWorkList(heads, chains, trash);
  assertEquals(work.versions.map((v) => `${v.path_hash[0]}@${v.version}`), ["a@1", "a@2", "b@1"]);
  assertEquals(work.chunks, [C1, C2, C3]);
  assertEquals(work.trash.length, 1);
});

Deno.test("rewriteVersionRow: a rename marker survives the re-key (#583)", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const path = "gone.md";
  const oldPathHash = hashPathHex(oldKeys.mac_key, path);
  const meta: FileMeta = {
    path,
    mtime: 1,
    size: 0,
    mime: "",
    plaintext_hash: "",
    renamed_to: "kept.md",
  };
  const encMetadata = b64encode(await encryptMetadata(meta, oldKeys, oldPathHash));
  const rec = record({
    path_hash: oldPathHash,
    version: 2,
    deleted: 1,
    rename_mark: 1,
    enc_metadata: encMetadata,
  });

  const item = await rewriteVersionRow(rec, oldKeys, newKeys);

  assertEquals(item.row.rename_mark, 1, "a re-key that drops it erases every rename link");
});

Deno.test("rewriteVersionRow: new path hash, re-encrypted metadata and path", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const path = "note.md";
  const oldPathHash = hashPathHex(oldKeys.mac_key, path);
  const meta: FileMeta = { path, mtime: 1, size: 3, mime: "text/markdown", plaintext_hash: "p" };
  const encMetadata = b64encode(await encryptMetadata(meta, oldKeys, oldPathHash));
  const pathCt = b64encode(await encryptPath(path, oldKeys, oldPathHash));
  const rec = record({
    path_hash: oldPathHash,
    version: 1,
    chunk_hashes: [C1],
    enc_metadata: encMetadata,
    path_ciphertext: pathCt,
    seq: 7,
    created_at: 123,
  });

  const item = await rewriteVersionRow(rec, oldKeys, newKeys);
  assertEquals(item.old_path_hash, oldPathHash);
  const newPathHash = hashPathHex(newKeys.mac_key, path);
  assertEquals(item.row.path_hash, newPathHash);
  assertEquals(item.row.seq, 7);
  assertEquals(item.row.created_at, 123);
  assertEquals(item.row.chunk_hashes, JSON.stringify([C1]));
  const metaOut = await decryptMetadata(b64decode(item.row.enc_metadata), newKeys, newPathHash);
  assertEquals(metaOut.path, path);
  assert(item.row.path_ciphertext);
  assertEquals(await decryptPath(b64decode(item.row.path_ciphertext!), newKeys, newPathHash), path);
});

Deno.test("rewriteTrashHead: new path hash, re-encrypted head_json", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const path = "gone.md";
  const oldPathHash = hashPathHex(oldKeys.mac_key, path);
  const meta: FileMeta = { path, mtime: 1, size: 3, mime: "text/markdown", plaintext_hash: "p" };
  const encMetadata = b64encode(await encryptMetadata(meta, oldKeys, oldPathHash));
  const pathCt = b64encode(await encryptPath(path, oldKeys, oldPathHash));
  const entry = {
    path_hash: oldPathHash,
    trashed_at: 42,
    deleted_by_device: "dev-x",
    head_json: JSON.stringify({
      version: 3,
      parent: 2,
      chunk_hashes: [C1],
      enc_metadata: encMetadata,
      path_ciphertext: pathCt,
      deleted: 0,
    }),
  };

  const item = await rewriteTrashHead(entry, oldKeys, newKeys);
  assertEquals(item.old_path_hash, oldPathHash);
  const newPathHash = hashPathHex(newKeys.mac_key, path);
  assertEquals(item.row.path_hash, newPathHash);
  assertEquals(item.row.deleted_by_device, "dev-x");
  assertEquals(item.row.trashed_at, 42);
  const headJson = JSON.parse(item.row.head_json) as {
    version: number;
    enc_metadata: string;
    path_ciphertext: string | null;
  };
  assertEquals(headJson.version, 3);
  const metaOut = await decryptMetadata(b64decode(headJson.enc_metadata), newKeys, newPathHash);
  assertEquals(metaOut.path, path);
  assert(headJson.path_ciphertext);
  assertEquals(await decryptPath(b64decode(headJson.path_ciphertext!), newKeys, newPathHash), path);
});

async function seededChain(oldKeys: VaultKeys): Promise<VersionRecord[]> {
  const path = "note.md";
  const pathHash = hashPathHex(oldKeys.mac_key, path);
  const meta: FileMeta = { path, mtime: 1, size: 3, mime: "text/markdown", plaintext_hash: "p" };
  const encMetadata = b64encode(await encryptMetadata(meta, oldKeys, pathHash));
  return [
    record({
      path_hash: pathHash,
      version: 1,
      chunk_hashes: [C1, C2, C3],
      enc_metadata: encMetadata,
    }),
  ];
}

async function seedBlobs(client: FakeClient, oldKeys: VaultKeys): Promise<void> {
  for (const [hash, data] of [[C1, "data1"], [C2, "data2"], [C3, "data3"]] as const) {
    client.blobs.set(hash, await encryptChunk(new TextEncoder().encode(data), oldKeys, hash));
  }
}

Deno.test("runRekey: abort mid-blobs, resume from cursor to completion", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const client = new FakeClient(await seededChain(oldKeys));
  await seedBlobs(client, oldKeys);
  const cursor = memoryCursor();
  const ac = new AbortController();
  let aborted = false;
  const onProgress = (p: { phase: string; done: number }) => {
    if (!aborted && p.phase === "blobs" && p.done >= 1) {
      aborted = true;
      ac.abort();
    }
  };

  await assertRejects(
    () =>
      runRekey({
        kind: "change",
        oldKeys,
        newKeys,
        params: FAST,
        mode: "copy",
        client,
        cursor,
        onProgress,
        signal: ac.signal,
      }),
    Error,
    "abort",
  );
  assertEquals(client.putCount, 1);
  assertEquals(cursor.current?.phase, "blobs");

  await runRekey({ kind: "change", oldKeys, newKeys, params: FAST, mode: "copy", client, cursor });
  assertEquals(client.putCount, 3);
  assertEquals(client.started, 1); // session started exactly once across the resume
  assertEquals(client.switched, 1);
  assertEquals(cursor.current, null); // cleared after the switch
  const pt = await decryptChunk(await client.getBlob(C1), newKeys, C1);
  assertEquals(new TextDecoder().decode(pt), "data1");
});

// #675: a vault whose auth_hash was never registered needs the admin token once;
// the plugin keeps none, so the run must stop with an instruction, not a raw 403.
Deno.test("runRekey: a refused auth registration explains how to register the vault", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const client = new FakeClient([]);
  client.registerAuth = () =>
    Promise.reject(new HttpStatusError(403, "auth registration failed: 403"));
  const error = await assertRejects(() =>
    runRekey({
      kind: "change",
      oldKeys,
      newKeys,
      params: FAST,
      mode: "copy",
      client,
      cursor: memoryCursor(),
    })
  );
  assertEquals(
    (error as Error).message,
    "This vault is not set up for rekey yet. Open Settings, run the setup wizard, join this vault again with the admin token, then retry.",
  );
  assertEquals(client.started, 0, "no session may open before the registration is refused");
});

Deno.test("runRekey resume: already-rewritten rows are skipped (replace mode)", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  // The chain now carries the NEW path hash + NEW-key metadata: the row was
  // already rewritten before the crash.
  const path = "note.md";
  const newPathHash = hashPathHex(newKeys.mac_key, path);
  const meta: FileMeta = { path, mtime: 1, size: 3, mime: "text/markdown", plaintext_hash: "p" };
  const encMetadata = b64encode(await encryptMetadata(meta, newKeys, newPathHash));
  const client = new FakeClient([
    record({ path_hash: newPathHash, version: 1, chunk_hashes: [], enc_metadata: encMetadata }),
  ]);
  const cursor = memoryCursor();
  cursor.save({
    kind: "rekey",
    mode: "replace",
    ops: FAST.ops,
    mem: FAST.mem,
    phase: "rows",
    blobs_done: 0,
  });

  await runRekey({
    kind: "rekey",
    oldKeys,
    newKeys,
    params: FAST,
    mode: "replace",
    client,
    cursor,
  });
  assertEquals(client.rowBatches.length, 0); // nothing left to post
  assertEquals(client.switched, 1);
});

Deno.test("runRekey: a fresh run fails on an undecryptable row (no silent skip)", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const path = "note.md";
  const newPathHash = hashPathHex(newKeys.mac_key, path);
  const meta: FileMeta = { path, mtime: 1, size: 3, mime: "text/markdown", plaintext_hash: "p" };
  const encMetadata = b64encode(await encryptMetadata(meta, newKeys, newPathHash));
  const client = new FakeClient([
    record({ path_hash: newPathHash, version: 1, chunk_hashes: [], enc_metadata: encMetadata }),
  ]);
  await assertRejects(
    () =>
      runRekey({
        kind: "change",
        oldKeys,
        newKeys,
        params: FAST,
        mode: "copy",
        client,
        cursor: memoryCursor(),
      }),
    Error,
  );
});

Deno.test("runRekey: a fresh run registers the auth key before starting the session", async () => {
  const oldKeys = await keys("old");
  const newKeys = await keys("new");
  const client = new FakeClient(await seededChain(oldKeys));
  await seedBlobs(client, oldKeys);
  const cursor = memoryCursor();
  await runRekey({ kind: "change", oldKeys, newKeys, params: FAST, mode: "copy", client, cursor });
  assertEquals(client.registered, 1);
  assertEquals(client.started, 1);
});
