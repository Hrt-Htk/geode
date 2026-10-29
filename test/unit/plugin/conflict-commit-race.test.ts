import { assertEquals } from "@std/assert";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { chunk } from "../../../core/chunker.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { b64encode, type ServerVersion } from "../../../core/protocol.ts";
import { commitOp } from "../../../plugin/sync/commit.ts";
import { ConflictHandler } from "../../../plugin/sync/conflict-handler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #630: a conflict resolution must never merge into a path whose own commit is
// still in flight. The merge writes the server copy over the bytes that commit is
// pushing, then the commit's ack records the merged write's mtime against the
// committed hash: a row and a disk that disagree while sharing one mtime, which
// the reconciler's mtime fast-path never re-reads. The device then holds a
// version its peers do not, forever (fuzz 3-dev seed 201, settle-non-termination).

const PATH = "notes.md";
const LOCAL = "head\nLOCAL\nbody\nfooter\n";
const REMOTE = "head\nREMOTE\nbody\nfooter\n";

async function remoteVersion(keys: VaultKeys, pathHash: string): Promise<ServerVersion> {
  const bytes = new TextEncoder().encode(REMOTE);
  const hashes: string[] = [];
  for (const c of chunk(bytes)) hashes.push(blake3Hex(c));
  const meta = {
    path: PATH,
    mtime: 1,
    size: bytes.length,
    mime: "text/markdown",
    plaintext_hash: blake3Hex(bytes),
  };
  return {
    type: "server_version",
    vault_id: "v",
    seq: 3,
    path_hash: pathHash,
    parent_version: 0,
    enc_metadata: b64encode(await encryptMetadata(meta, keys, pathHash)),
    chunk_hashes: hashes,
    deleted: false,
    device_id: "device-B",
    version: 1,
  };
}

Deno.test("conflict-handler waits for an in-flight same-path commit, then resolves as stale", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const pathHash = hashPathHex(keys.mac_key, PATH);
  const vault = new FakeVault();
  vault.write(PATH, LOCAL);
  const state = openStateDB();
  // A carried row (#583): the edit arrived with a rename, so it has no version of
  // this path and the merge has no common ancestor: the resolve writes the server
  // copy over the file (the shape that clobbers an in-flight commit).
  state.upsertLocalFile({
    path: PATH,
    path_hash: pathHash,
    size: LOCAL.length,
    mtime: vault.mtimes.get(PATH)!,
    plaintext_hash: blake3Hex(new TextEncoder().encode(LOCAL)),
    last_seen_version: 0,
    chunk_hashes: [],
  });

  const remote = await remoteVersion(keys, pathHash);
  const blobs = new Map<string, Uint8Array>();
  for (const c of chunk(new TextEncoder().encode(REMOTE))) {
    const h = blake3Hex(c);
    blobs.set(h, await encryptChunk(c, keys, h));
  }

  let releaseCommit = () => {};
  const commitInFlight = new Promise<void>((r) => (releaseCommit = r));
  let commitStarted = () => {};
  const started = new Promise<void>((r) => (commitStarted = r));
  const transport = {
    async *getHeads() {
      yield {
        path_hash: pathHash,
        version: 1,
        seq: 3,
        enc_metadata: remote.enc_metadata,
        chunk_hashes: remote.chunk_hashes,
        deleted: 0,
        device_id: "device-B",
      };
    },
    getBlob: (hash: string) => blobs.get(hash)!,
    headBlob: () => true,
    putBlob: async () => {},
    commit: async () => {
      commitStarted();
      await commitInFlight;
      return { kind: "ack", version: 2 };
    },
  };

  const commitDeps = {
    vault: { adapter: vault.adapter },
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
    pendingRenameTarget: () => undefined,
  };
  const pushing = commitOp({ kind: "commit", path: PATH }, commitDeps as never);
  await started;

  const localEditPaths = new Set([PATH]);
  const handler = new ConflictHandler({
    vault: { adapter: vault.adapter } as never,
    vaultId: "v",
    getDeviceName: () => "device-A",
    deviceId: "device-A",
    transport: transport as never,
    getState: () => state,
    getKeys: () => keys,
    onStatusUpdate: () => {},
    versionCache: new Map(),
    localEditPaths,
    suppressSelfWrite: () => {},
    pendingRenameTarget: () => undefined,
    files: () => [...vault.files.keys()].map((path) => ({ path })),
  });

  const resolving = handler.handleConflict(PATH, { path_hash: pathHash, version: 1 });
  // Let the resolution reach its first await: without the wait it writes here.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assertEquals(new TextDecoder().decode(vault.files.get(PATH)), LOCAL, "in-flight bytes kept");

  releaseCommit();
  await pushing;
  await resolving;

  assertEquals(
    new TextDecoder().decode(vault.files.get(PATH)),
    LOCAL,
    "the committed bytes stay on disk (the resolution was stale)",
  );
  assertEquals(
    [...vault.files.keys()].some((p) => p.includes("conflict")),
    false,
    "no conflict file for a resolution the commit already superseded",
  );
  const row = state.getLocalFile(PATH)!;
  assertEquals(row.last_seen_version, 2, "the commit's version is recorded");
  assertEquals(
    row.plaintext_hash,
    blake3Hex(new TextEncoder().encode(LOCAL)),
    "the row describes the committed bytes",
  );
  assertEquals(
    row.mtime,
    vault.mtimes.get(PATH),
    "the row's mtime is the mtime of the bytes it describes, so the reconciler sees any drift",
  );
  state.close();
});
