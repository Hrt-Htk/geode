import { assert, assertEquals } from "@std/assert";
import { b64encode } from "../../../core/protocol.ts";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { prepareRejoin, type RejoinDeps } from "../../../plugin/sync/rejoin.ts";
import { FakeVault } from "../../two-vault-driver.ts";

// #701: prepareRejoin decides per path whether the server already holds the bytes, and
// that decision is what keeps a rejoin from copying a whole unchanged vault into the
// backup folder. The head-hash fast path is the cheap half of it: a file equal to its
// live head is answered from the heads the rebuild fetched, with no request at all.

const SALT = new Uint8Array(16);
const PASS = "rejoin-prepare";

async function keys(): Promise<VaultKeys> {
  return await deriveKeys(PASS, SALT, { opsLimit: 1, memLimit: 8192 });
}

function contentHash(path: string, text: string): string {
  return blake3Hex(normalizeForHash(path, new TextEncoder().encode(text)));
}

async function headFor(
  vaultKeys: VaultKeys,
  path: string,
  text: string,
  deleted = false,
): Promise<RejoinDeps["heads"][number]> {
  const pathHash = hashPathHex(vaultKeys.mac_key, path);
  const enc = await encryptMetadata(
    {
      path,
      mtime: 1,
      size: text.length,
      mime: "text/markdown",
      plaintext_hash: deleted ? "" : contentHash(path, text),
    },
    vaultKeys,
    pathHash,
  );
  return {
    path_hash: pathHash,
    version: 1,
    seq: 1,
    enc_metadata: b64encode(enc),
    chunk_hashes: [],
    deleted,
    path_ciphertext: null,
    rename_mark: 0,
  };
}

/** A deps set whose chain must not be asked: any call fails the case. */
function deps(
  vault: FakeVault,
  vaultKeys: VaultKeys,
  heads: RejoinDeps["heads"],
): { deps: RejoinDeps; chainCalls: () => number } {
  let calls = 0;
  return {
    deps: {
      vault,
      state: openStateDB(),
      keys: vaultKeys,
      isSyncable: () => true,
      heads,
      chainOf: () => {
        calls++;
        return Promise.reject(new Error("the chain must not be asked"));
      },
    },
    chainCalls: () => calls,
  };
}

Deno.test("rejoin-prepare - a file equal to its live head is not copied and asks nothing", async () => {
  const vaultKeys = await keys();
  const vault = new FakeVault();
  vault.write("note.md", "unchanged\n");
  const { deps: rejoinDeps, chainCalls } = deps(vault, vaultKeys, [
    await headFor(vaultKeys, "note.md", "unchanged\n"),
  ]);

  const prepared = await prepareRejoin(rejoinDeps);

  assertEquals(prepared.backup, null);
  assertEquals(prepared.edits.size, 0);
  assertEquals(prepared.unreadable.length, 0);
  assertEquals(chainCalls(), 0, "the head answers an unchanged file, no chain request");
  assertEquals([...vault.files.keys()], ["note.md"], "nothing was written");
});

Deno.test("rejoin-prepare - a file the head does not hold asks the chain once, then copies", async () => {
  const vaultKeys = await keys();
  const vault = new FakeVault();
  vault.write("note.md", "edited here\n");
  const { deps: rejoinDeps, chainCalls } = deps(vault, vaultKeys, [
    await headFor(vaultKeys, "note.md", "server copy\n"),
  ]);

  const prepared = await prepareRejoin(rejoinDeps);

  assertEquals(chainCalls(), 1);
  assertEquals(prepared.edits.size, 0); // no row: doubtful, not an edit
  assertEquals(prepared.backup?.count, 1);
  assert(prepared.backup!.folder.startsWith("Geode backup/"), prepared.backup!.folder);
  assertEquals(
    [...vault.files.keys()].sort(),
    ["Geode backup/" + prepared.backup!.folder.split("/")[1] + "/note.md", "note.md"].sort(),
  );
  assertEquals(prepared.unreadable.length, 0);
});

Deno.test("rejoin-prepare - a live row whose bytes the chain knows is a stale copy", async () => {
  const vaultKeys = await keys();
  const vault = new FakeVault();
  vault.write("note.md", "summer copy\n");
  const pathHash = hashPathHex(vaultKeys.mac_key, "note.md");
  const state = openStateDB([{
    path: "note.md",
    path_hash: pathHash,
    size: 1,
    mtime: 1,
    plaintext_hash: "old",
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  }]);
  const enc = await encryptMetadata(
    {
      path: "note.md",
      mtime: 1,
      size: 1,
      mime: "text/markdown",
      plaintext_hash: contentHash("note.md", "summer copy\n"),
    },
    vaultKeys,
    pathHash,
  );

  const prepared = await prepareRejoin({
    vault,
    state,
    keys: vaultKeys,
    isSyncable: () => true,
    heads: [await headFor(vaultKeys, "note.md", "winter copy\n")],
    chainOf: () =>
      Promise.resolve([{
        version: 1,
        parent: null,
        path_hash: pathHash,
        chunk_hashes: [],
        enc_metadata: b64encode(enc),
        compacted_range: null,
        path_ciphertext: null,
        device_id: "d",
        seq: 1,
        created_at: 1,
        deleted: 0,
        rename_mark: 0,
      }]),
  });

  assertEquals(prepared.backup, null, "a version the server holds is never copied");
  assertEquals(prepared.edits.size, 0, "and it is not an edit");
});

Deno.test("rejoin-prepare - an unreadable file is reported, never copied", async () => {
  const vaultKeys = await keys();
  const vault = new FakeVault();
  vault.write("locked.md", "bytes\n");
  const original = vault.readBinary.bind(vault);
  vault.readBinary = (path: string) =>
    path === "locked.md" ? Promise.reject(new Error("EIO")) : original(path);
  const { deps: rejoinDeps } = deps(vault, vaultKeys, []);

  const prepared = await prepareRejoin(rejoinDeps);

  assertEquals(prepared.unreadable, ["locked.md"]);
  assertEquals(prepared.backup, null);
  assertEquals(prepared.edits.size, 0);
});
