import { assertEquals } from "@std/assert";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion } from "../../../core/protocol.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #59: an Android force-stop inside a download leaves a torn file whose row never
// persisted. Bytes left by this device's own write are not a local edit: the head is
// written over them, and no conflict copy is ever made from the fragment.

const PATH = "note.md";
const V1 = "# note\none\ntwo\nthree\nfour\nfive\nsix\n";
const V2 = "# note\none\ntwo\nthree\nfour\nfive\nsix\nseven\n";
/** What the kill left in the note: the write stopped after its first bytes. */
const FRAGMENT = "";

type Harness = {
  vault: FakeVault;
  state: StateDB;
  keys: VaultKeys;
  versionOf: (content: string, version: number) => Promise<ServerVersion>;
  deps: (overrides?: Partial<ApplyDeps>) => ApplyDeps;
  promoted: string[];
  conflicts: string[];
  /** Every binary write this apply performed (a download, not a row-only apply). */
  writes: string[];
  fetches: string[];
};

async function harness(): Promise<Harness> {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const vault = new FakeVault();
  const state = openStateDB();
  const pathHash = hashPathHex(keys.mac_key, PATH);
  const blobs = new Map<string, Uint8Array>();
  const promoted: string[] = [];
  const conflicts: string[] = [];
  const writes: string[] = [];
  const fetches: string[] = [];
  const writeBinary = vault.writeBinary.bind(vault);
  vault.writeBinary = (path: string, data: Uint8Array, opts?: { mtime?: number }) => {
    writes.push(path);
    writeBinary(path, data, opts);
  };

  const versionOf = async (content: string, version: number): Promise<ServerVersion> => {
    const normalized = normalizeForHash(PATH, new TextEncoder().encode(content));
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
          path: PATH,
          mtime: 1_000 * version,
          size: normalized.length,
          mime: "text/markdown",
          plaintext_hash: plaintextHash,
        },
        keys,
        pathHash,
      ),
    );
    return {
      type: "server_version",
      vault_id: "vault",
      seq: version,
      path_hash: pathHash,
      parent_version: version - 1,
      enc_metadata: encMetadata,
      chunk_hashes: chunkHashes,
      deleted: false,
      device_id: "peer",
      version,
    };
  };

  const deps = (overrides: Partial<ApplyDeps> = {}): ApplyDeps => ({
    vault: vault as unknown as ApplyDeps["vault"],
    state,
    keys,
    getBlob: (hash) => {
      fetches.push(hash);
      return Promise.resolve(blobs.get(hash)!);
    },
    hasLocalEdits: () => false,
    onConflict: (path) => {
      conflicts.push(path);
    },
    markLocalEdit: (path) => {
      promoted.push(path);
    },
    myDeviceId: "device-a",
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
    ...overrides,
  });

  return { vault, state, keys, versionOf, deps, promoted, conflicts, writes, fetches };
}

const disk = (h: Harness) => new TextDecoder().decode(h.vault.files.get(PATH)!);

Deno.test("apply - an interrupted create is downloaded again, never kept as an edit", async () => {
  const h = await harness();
  try {
    const head = await h.versionOf(V1, 1);
    // The kill: the file exists (0 bytes written), the row never persisted.
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));

    await applyVersion(head, h.deps({ tornDownload: true, force: true }));

    assertEquals(disk(h), V1, "the server head lands on disk");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 1);
    assertEquals(h.promoted, [], "the fragment is not promoted to a local edit");
    assertEquals(h.conflicts, [], "no conflict copy is made from the fragment");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - an interrupted update overwrites the torn fragment with the head", async () => {
  const h = await harness();
  try {
    const v1 = await h.versionOf(V1, 1);
    await applyVersion(v1, h.deps());
    assertEquals(disk(h), V1);
    // v2 was being written when the app was killed: the row still says v1.
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
    const v2 = await h.versionOf(V2, 2);

    await applyVersion(v2, h.deps({ tornDownload: true, force: true }));

    assertEquals(disk(h), V2, "the head replaces the fragment, nothing is merged into it");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 2);
    assertEquals(h.promoted, [], "the truncated file is not treated as an edit");
    assertEquals(h.conflicts, []);
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a download that finished before the kill only gets its row", async () => {
  const h = await harness();
  try {
    const head = await h.versionOf(V1, 1);
    // The batch wrote this file completely and died before its row persisted.
    h.vault.files.set(PATH, new TextEncoder().encode(V1));

    await applyVersion(head, h.deps({ tornDownload: true, force: true }));

    assertEquals(h.writes, [], "the bytes are already there: no download, no rewrite");
    assertEquals(h.fetches, [], "no chunk is fetched for a file the disk already holds");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 1, "the row is recorded");
    assertEquals(h.promoted, []);
  } finally {
    h.state.close();
  }
});
