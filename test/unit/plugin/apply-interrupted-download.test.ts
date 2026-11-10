import { assertEquals } from "@std/assert";
import { type ApplyDeps, applyVersion } from "../../../plugin/sync/apply.ts";
import { type InFlightWrite, type StateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, RENAME_MARKER, type ServerVersion } from "../../../core/protocol.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { openSessionStateDB } from "../../helpers/state.ts";

// #59: an interrupted write leaves a torn file whose row never persisted. While the record
// says the path is torn (this session's write has not returned, or the start pass has not
// resolved it), the apply writes the head over the bytes instead of merging or keeping
// them; an edit the user has queued or not yet flushed still wins.

const PATH = "note.md";
const V1 = "# note\none\ntwo\nthree\nfour\nfive\nsix\n";
const V2 = "# note\none\ntwo\nthree\nfour\nfive\nsix\nseven\n";
const DESTINATION = "moved.md";
/** What the kill left in the note: the write stopped after its first bytes. */
const FRAGMENT = "# no";

type Harness = {
  vault: FakeVault;
  state: StateDB;
  keys: VaultKeys;
  versionOf: (content: string, version: number) => Promise<ServerVersion>;
  markerOf: (path: string, to: string, version: number) => Promise<ServerVersion>;
  deps: (overrides?: Partial<ApplyDeps>) => ApplyDeps;
  promoted: string[];
  conflicts: string[];
  writes: string[];
};

async function harness(tornPaths: string[] = []): Promise<Harness> {
  const keys = await deriveKeys("test", crypto.getRandomValues(new Uint8Array(16)), {
    opsLimit: 1,
    memLimit: 8192,
  });
  const vault = new FakeVault();
  const pathHash = hashPathHex(keys.mac_key, PATH);
  const record: InFlightWrite[] = tornPaths.map((path) => ({
    path,
    path_hash: path === PATH ? pathHash : hashPathHex(keys.mac_key, path),
    expected_plaintext_hash: "the-write-never-finished",
    expected_size: 1_000,
  }));
  const state = openSessionStateDB(null, null, null, record);
  // The start pass claims a recorded path before writing it: only then may an apply treat
  // those bytes as its own (an unclaimed record parks every version for that path).
  const blobs = new Map<string, Uint8Array>();
  const promoted: string[] = [];
  const conflicts: string[] = [];
  const writes: string[] = [];
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
    getBlob: (hash) => Promise.resolve(blobs.get(hash)!),
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
    // These cases are the start pass's own applies: only it may write over a recorded path.
    managesInterrupted: true,
    ...overrides,
  });

  return { vault, state, keys, versionOf, markerOf, deps, promoted, conflicts, writes };
}

const disk = (h: Harness, path = PATH) =>
  h.vault.files.has(path) ? new TextDecoder().decode(h.vault.files.get(path)!) : "<gone>";

Deno.test("apply - a torn create gets the head written over it", async () => {
  const h = await harness([PATH]);
  try {
    const head = await h.versionOf(V1, 1);
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));

    await applyVersion(head, h.deps({ force: true }));

    assertEquals(disk(h), V1, "the server head lands on disk");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 1);
    assertEquals(
      h.state.getLocalFile(PATH)?.plaintext_hash,
      blake3Hex(
        normalizeForHash(PATH, new TextEncoder().encode(V1)),
      ),
    );
    assertEquals(h.promoted, [], "the fragment is not promoted to a local edit");
    assertEquals(h.conflicts, [], "no conflict copy is made from the fragment");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a torn update is overwritten by the head, not merged", async () => {
  const h = await harness([PATH]);
  try {
    const v1 = await h.versionOf(V1, 1);
    await applyVersion(v1, h.deps());
    assertEquals(disk(h), V1);
    h.vault.files.set(PATH, new TextEncoder().encode(FRAGMENT));
    const v2 = await h.versionOf(V2, 2);

    await applyVersion(v2, h.deps({ force: true }));

    assertEquals(disk(h), V2, "the head replaces the fragment, nothing is merged into it");
    assertEquals(h.state.getLocalFile(PATH)?.last_seen_version, 2);
    assertEquals(h.promoted, []);
    assertEquals(h.conflicts, []);
  } finally {
    h.state.close();
  }
});

Deno.test("apply - an edit still in the event debounce wins over the fragment", async () => {
  const h = await harness([PATH]);
  try {
    const head = await h.versionOf(V1, 1);
    const typed = "# note\nstill typing here";
    h.vault.files.set(PATH, new TextEncoder().encode(typed));

    // The user is repairing the torn note: their unflushed op must not be overwritten.
    await applyVersion(head, h.deps({ force: true, hasUnflushedEdit: () => true }));

    assertEquals(disk(h), typed, "the typing stays on disk");
    assertEquals(h.writes, [], "the head is not written over it");
    assertEquals(h.promoted, [PATH], "it is promoted as a local edit for the conflict path");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a rename marker never carries the fragment to the new name", async () => {
  const h = await harness([PATH]);
  try {
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

Deno.test("apply - a version for an unresolved entry is parked, not applied over the bytes", async () => {
  const h = await harness([PATH]);
  try {
    // The start pass has not resolved this path's record yet (it is still running, or was
    // abandoned by its bound): an outside edit sits on disk.
    const outside = "# note\nmine\n";
    h.vault.files.set(PATH, new TextEncoder().encode(outside));
    const head = await h.versionOf(V1, 1);
    h.writes.length = 0;
    h.state.holdSyncCursor(0);

    await applyVersion(head, h.deps({ force: true, managesInterrupted: false }));

    assertEquals(disk(h), outside, "the parked version does not touch the bytes");
    assertEquals(h.writes, [], "no write at all");
    assertEquals(h.promoted, [], "and nothing is promoted as an edit either");
    assertEquals(h.state.getSyncCursor(), 0, "the cursor stays behind the parked version");
  } finally {
    h.state.close();
  }
});

Deno.test("apply - a fetch that fails writes nothing and holds the cursor", async () => {
  const h = await harness();
  try {
    const head = await h.versionOf(V1, 1);
    h.writes.length = 0;

    let failed = false;
    await applyVersion(
      head,
      h.deps({
        getBlob: () => Promise.reject(new Error("blob GET: timed out")),
      }),
    ).catch(() => {
      failed = true;
    });

    assertEquals(failed, true, "the apply fails instead of hanging");
    assertEquals(h.writes, [], "nothing is written before the fetch succeeds");
    assertEquals(h.state.getSyncCursor(), 0, "the cursor stays behind: the version is retried");
    assertEquals(h.state.isTorn(hashPathHex(h.keys.mac_key, PATH)), false, "nothing claimed");
  } finally {
    h.state.close();
  }
});
