import { assertEquals } from "@std/assert";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, RENAME_MARKER, type ServerVersion } from "../../../core/protocol.ts";
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
const DESTINATION = "moved.md";
/** What the kill left in the note: the write stopped after its first bytes. */
const FRAGMENT = "";

type Harness = {
  vault: FakeVault;
  state: StateDB;
  keys: VaultKeys;
  pathHash: string;
  versionOf: (content: string, version: number) => Promise<ServerVersion>;
  markerOf: (path: string, to: string, version: number) => Promise<ServerVersion>;
  deps: (overrides?: Partial<ApplyDeps>) => ApplyDeps;
  promoted: string[];
  conflicts: string[];
  /** Every binary write this apply performed (a download, not a row-only apply). */
  writes: string[];
  fetches: string[];
};

async function harness(interrupted = false): Promise<Harness> {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const vault = new FakeVault();
  const pathHash = hashPathHex(keys.mac_key, PATH);
  // A record read back from the last session: this path's bytes may be a fragment.
  const state = openStateDB(null, null, null, interrupted ? [pathHash] : []);
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

  const meta = async (
    path: string,
    content: string,
    version: number,
    extra: { renamed_to?: string } = {},
  ) => {
    const normalized = normalizeForHash(path, new TextEncoder().encode(content));
    const plaintextHash = content === "" ? "" : blake3Hex(normalized);
    const chunkHashes: string[] = [];
    if (content !== "") {
      for (const part of chunk(normalized)) {
        const hash = blake3Hex(part);
        chunkHashes.push(hash);
        blobs.set(hash, await encryptChunk(part, keys, hash));
      }
    }
    const encMetadata = b64encode(
      await encryptMetadata(
        {
          path,
          mtime: 1_000 * version,
          size: normalized.length,
          mime: "text/markdown",
          plaintext_hash: plaintextHash,
          ...extra,
        },
        keys,
        hashPathHex(keys.mac_key, path),
      ),
    );
    return { encMetadata, chunkHashes };
  };

  const versionOf = async (content: string, version: number): Promise<ServerVersion> => {
    const { encMetadata, chunkHashes } = await meta(PATH, content, version);
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

  /** A peer's rename: the old name closes with a marker pointing at `to`. */
  const markerOf = async (path: string, to: string, version: number): Promise<ServerVersion> => {
    const { encMetadata, chunkHashes } = await meta(path, "", version, { renamed_to: to });
    return {
      type: "server_version",
      vault_id: "vault",
      seq: version,
      path_hash: hashPathHex(keys.mac_key, path),
      parent_version: version - 1,
      enc_metadata: encMetadata,
      chunk_hashes: chunkHashes,
      deleted: true,
      device_id: "peer",
      version,
      rename_mark: RENAME_MARKER,
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

  return {
    vault,
    state,
    keys,
    pathHash,
    versionOf,
    markerOf,
    deps,
    promoted,
    conflicts,
    writes,
    fetches,
  };
}

const disk = (h: Harness, path = PATH) =>
  h.vault.files.has(path) ? new TextDecoder().decode(h.vault.files.get(path)!) : "<gone>";

Deno.test("apply - an interrupted create is downloaded again, never kept as an edit", async () => {
  const h = await harness(true);
  try {
    const head = await h.versionOf(V1, 1);
    // The kill: the file exists (0 bytes written), the row never persisted.
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));

    await applyVersion(head, h.deps({ force: true }));

    assertEquals(disk(h), V1, "the server head lands on disk");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 1);
    assertEquals(h.promoted, [], "the fragment is not promoted to a local edit");
    assertEquals(h.conflicts, [], "no conflict copy is made from the fragment");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - an interrupted update overwrites the torn fragment with the head", async () => {
  const h = await harness(true);
  try {
    const v1 = await h.versionOf(V1, 1);
    await applyVersion(v1, h.deps());
    assertEquals(disk(h), V1);
    // v2 was being written when the app was killed: the row still says v1.
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
    const v2 = await h.versionOf(V2, 2);

    await applyVersion(v2, h.deps({ force: true }));

    assertEquals(disk(h), V2, "the head replaces the fragment, nothing is merged into it");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 2);
    assertEquals(h.promoted, [], "the truncated file is not treated as an edit");
    assertEquals(h.conflicts, []);
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a download that finished before the kill only gets its row", async () => {
  const h = await harness(true);
  try {
    const head = await h.versionOf(V1, 1);
    // The batch wrote this file completely and died before its row persisted.
    h.vault.files.set(PATH, new TextEncoder().encode(V1));

    await applyVersion(head, h.deps({ force: true }));

    assertEquals(h.writes, [], "the bytes are already there: no download, no rewrite");
    assertEquals(h.fetches, [], "no chunk is fetched for a file the disk already holds");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 1, "the row is recorded");
    assertEquals(h.promoted, []);
  } finally {
    h.state.close();
  }
});

Deno.test("apply - an edit still in the event debounce wins over the fragment", async () => {
  // The path IS interrupted: without the debounce gate the head would overwrite the typing.
  const h = await harness(true);
  try {
    const head = await h.versionOf(V1, 1);
    const typed = "# note\nstill typing here";
    h.vault.files.set(PATH, new TextEncoder().encode(typed));

    // The user is repairing the truncated note: their unflushed op must not be overwritten.
    await applyVersion(head, h.deps({ force: true, hasUnflushedEdit: () => true }));

    assertEquals(disk(h), typed, "the typing stays on disk");
    assertEquals(h.writes, [], "the head is not written over it");
    assertEquals(h.promoted, [PATH], "it is promoted as a local edit for the conflict path");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a rename marker never carries the fragment to the new name", async () => {
  const h = await harness(true);
  try {
    // The killed download sits at the old name; the peer renamed the note away meanwhile.
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
    h.vault.mtimes.set(PATH, Date.now());
    const marker = await h.markerOf(PATH, DESTINATION, 1);

    await applyVersion(
      marker,
      h.deps({
        force: true,
        isSyncable: () => true,
        renameHeadOf: () => Promise.resolve({ version: 1, deleted: 0 }),
      }),
    );

    assertEquals(disk(h, PATH), "<gone>", "the old name is emptied");
    assertEquals(disk(h, DESTINATION), "<gone>", "the fragment is not moved to the new name");
    assertEquals(
      [...h.vault.files.keys()].filter((path) => path.includes("conflict")),
      [],
      "no conflict sibling holds the fragment",
    );
    assertEquals(h.state.getLocalFile(PATH)?.deleted, true, "the old name's row is closed");
  } finally {
    h.state.close();
  }
});
