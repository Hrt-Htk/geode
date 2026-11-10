import { assertEquals } from "@std/assert";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type VersionRecord } from "../../../core/protocol.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { type ApplyDeps, identityHash } from "../../../plugin/sync/apply.ts";
import { resolveInterruptedWrites } from "../../../plugin/sync/interrupted-writes.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #59: the ONE start pass. A record entry says "this device was writing these bytes"; the
// pass decides what actually happened from the disk, the row and the server head, and then
// clears every entry: a record never survives the start that read it.

const PATH = "note.md";
const V1 = "# note\none\ntwo\nthree\nfour\nfive\nsix\n";
const V2 = "# note\none\ntwo\nthree\nfour\nfive\nsix\nseven\n";
const FRAGMENT = "# no";

type Harness = {
  vault: FakeVault;
  keys: VaultKeys;
  pathHash: string;
  /** A state as the next start reads it: the rows that persisted, plus the record. */
  started: (
    entries: { expected: string; path?: string; head?: VersionRecord | null }[],
    rows?: { path: string; plaintext_hash: string; last_seen_version: number }[],
  ) => StateDB;
  /** The one start pass, over a state built by `started`. */
  pass: (state: StateDB) => Promise<void>;
  applyDeps: (state: StateDB) => ApplyDeps;
  writes: string[];
};

async function harness(): Promise<Harness> {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const vault = new FakeVault();
  const pathHash = hashPathHex(keys.mac_key, PATH);
  const blobs = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const heads = new Map<string, VersionRecord | null>();
  const writeBinary = vault.writeBinary.bind(vault);
  vault.writeBinary = (path: string, data: Uint8Array, opts?: { mtime?: number }) => {
    writes.push(path);
    writeBinary(path, data, opts);
  };

  const versionOf = async (path: string, content: string): Promise<VersionRecord> => {
    const normalized = normalizeForHash(path, new TextEncoder().encode(content));
    const plaintextHash = blake3Hex(normalized);
    const chunkHashes: string[] = [];
    for (const part of chunk(normalized)) {
      const hash = blake3Hex(part);
      chunkHashes.push(hash);
      blobs.set(hash, await encryptChunk(part, keys, hash));
    }
    const encMetadata = b64encode(
      await encryptMetadata(
        {
          path,
          mtime: 1_000,
          size: normalized.length,
          mime: "text/markdown",
          plaintext_hash: plaintextHash,
        },
        keys,
        hashPathHex(keys.mac_key, path),
      ),
    );
    return {
      version: 1,
      parent: null,
      path_hash: hashPathHex(keys.mac_key, path),
      chunk_hashes: chunkHashes,
      enc_metadata: encMetadata,
      compacted_range: null,
      path_ciphertext: null,
      device_id: "peer",
      seq: 1,
      created_at: 1,
      deleted: 0,
      rename_mark: 0,
    };
  };
  heads.set(pathHash, await versionOf(PATH, V2));

  const applyDeps = (state: StateDB): ApplyDeps => ({
    vault: vault as unknown as ApplyDeps["vault"],
    state,
    keys,
    getBlob: (hash) => Promise.resolve(blobs.get(hash)!),
    hasLocalEdits: () => false,
    onConflict: () => {},
    markLocalEdit: () => {},
    myDeviceId: "device-a",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
  });

  const started: Harness["started"] = (entries, rows = []) => {
    for (const entry of entries) {
      heads.set(
        hashPathHex(keys.mac_key, entry.path ?? PATH),
        entry.head ?? heads.get(
          hashPathHex(keys.mac_key, entry.path ?? PATH),
        ) ?? null,
      );
    }
    return openStateDB(
      rows.map((row) => ({
        ...row,
        path_hash: hashPathHex(keys.mac_key, row.path),
        size: 0,
        mtime: 1,
        chunk_hashes: [],
        deleted: false,
      })),
      null,
      null,
      entries.map((entry) => ({
        path: entry.path ?? PATH,
        path_hash: hashPathHex(keys.mac_key, entry.path ?? PATH),
        expected_plaintext_hash: entry.expected,
      })),
    );
  };

  const pass = async (state: StateDB): Promise<void> => {
    try {
      await resolveInterruptedWrites({
        state,
        keys,
        vaultId: "vault",
        apply: { ...applyDeps(state), force: true },
        chainHead: (hash) => Promise.resolve(heads.get(hash) ?? null),
      });
      assertEquals(state.getInterruptedWrites(), [], "nothing survives the pass");
    } finally {
      state.close();
    }
  };

  return { vault, keys, pathHash, started, pass, applyDeps, writes };
}

const disk = (h: Harness, path = PATH) =>
  h.vault.files.has(path) ? new TextDecoder().decode(h.vault.files.get(path)!) : "<gone>";

Deno.test("interrupted-writes - a torn file with a head gets the head written over it", async () => {
  const h = await harness();
  h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));

  await h.pass(h.started([{ expected: identityHash(PATH, new TextEncoder().encode(V2)) }]));

  assertEquals(disk(h), V2);
});

Deno.test("interrupted-writes - a write that never started is left alone", async () => {
  const h = await harness();
  // The row still tracks the bytes on disk: the write never reached the file.
  h.vault.files.set(PATH, new TextEncoder().encode(V1));
  h.writes.length = 0;
  const state = h.started([{ expected: identityHash(PATH, new TextEncoder().encode(V2)) }], [{
    path: PATH,
    plaintext_hash: identityHash(PATH, new TextEncoder().encode(V1)),
    last_seen_version: 1,
  }]);

  await h.pass(state);

  assertEquals(disk(h), V1, "nothing is forced over bytes the write never touched");
  assertEquals(h.writes, [], "no write at all");
});

Deno.test("interrupted-writes - a write that completed is kept and cleared", async () => {
  const h = await harness();
  // The write landed (it holds the expected bytes) but the commit/merge after it did not.
  const merged = "# note\none\ntwo\n";
  h.vault.files.set(PATH, new TextEncoder().encode(merged));
  h.writes.length = 0;

  await h.pass(h.started([{ expected: identityHash(PATH, new TextEncoder().encode(merged)) }]));

  assertEquals(disk(h), merged, "a completed write is not a fragment");
  assertEquals(h.writes, [], "it is left for the reconciler, not rewritten");
});

Deno.test("interrupted-writes - a torn file with no head is deleted, never committed", async () => {
  const h = await harness();
  // A conflict sibling or a rejoin backup copy: this device made it, the server never
  // committed that path.
  const sibling = "note (conflict device-a 2026-11-10 170000).md";
  h.vault.files.set(sibling, new TextEncoder().encode(FRAGMENT));

  await h.pass(h.started([{
    path: sibling,
    expected: identityHash(sibling, new TextEncoder().encode(V1)),
    head: null,
  }]));

  assertEquals(disk(h, sibling), "<gone>", "the partial copy is removed");
});

Deno.test("interrupted-writes - an entry whose head equals the disk is cleared without a write", async () => {
  const h = await harness();
  h.vault.files.set(PATH, new TextEncoder().encode(V2)); // the head landed
  h.writes.length = 0;

  await h.pass(h.started([{ expected: identityHash(PATH, new TextEncoder().encode(V1)) }]));

  assertEquals(disk(h), V2);
  assertEquals(h.writes, [], "a landed write is not rewritten");
});

Deno.test("interrupted-writes - a head fetch that fails keeps the entry gated for the next connection", async () => {
  const h = await harness();
  // The record survives the first connection's pass: the server could not answer, so the
  // fragment is still unprotected and must stay gated (never committed) until it resolves.
  h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
  h.writes.length = 0;
  const state = h.started([{ expected: identityHash(PATH, new TextEncoder().encode(V2)) }]);

  await resolveInterruptedWrites({
    state,
    keys: h.keys,
    vaultId: "vault",
    apply: { ...h.applyDeps(state), force: true },
    chainHead: () => Promise.reject(new Error("heads GET timed out after 60000ms")),
  });

  assertEquals(state.getInterruptedWrites().length, 1, "an unresolved entry stays recorded");
  assertEquals(state.isTorn(h.pathHash), true, "and stays gated: no pass may commit it");
  assertEquals(h.writes, [], "nothing is written over a fragment the server cannot answer for");
  assertEquals(disk(h), FRAGMENT, "the fragment is untouched");

  // The next connection: the server answers, the head goes over the fragment, the record
  // is cleared.
  await h.pass(state);

  assertEquals(disk(h), V2);
  assertEquals(h.writes, [PATH], "the head is written once the fetch succeeds");
  state.close();
});

Deno.test("interrupted-writes - no record, no pass", async () => {
  const h = await harness();
  h.writes.length = 0;
  await resolveInterruptedWrites({
    state: h.started([]),
    keys: h.keys,
    vaultId: "vault",
    apply: {} as ApplyDeps,
    chainHead: () => Promise.reject(new Error("no head is asked for")),
  });
  assertEquals(h.writes, []);
});
