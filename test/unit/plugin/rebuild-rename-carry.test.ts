// #55: a rebuild that re-applies a rename marker must not turn a case-only rename into a
// conflict copy, and a copy it does make carries this device's name, never "This device".

import { assertEquals } from "@std/assert";
import {
  b64encode,
  type FileMeta,
  type HeadRecord,
  RENAME_MARKER,
} from "../../../core/protocol.ts";
import { deriveKeys, encryptChunk, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { chunk } from "../../../core/chunker.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { rebuildFromScratch, type ResyncDeps } from "../../../plugin/sync/recovery.ts";
import { conflictDeviceName } from "../../../plugin/sync/conflicts.ts";

const SALT = new Uint8Array(16);
const PASS = "rebuild-rename-carry";
const DEVICE = "Laptop";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function keys(): Promise<VaultKeys> {
  return await deriveKeys(PASS, SALT, { opsLimit: 1, memLimit: 8192 });
}

/** A disk double with optional case-insensitive resolution: on APFS/NTFS a case-only
 * rename leaves one inode for "a.md" and "A.md". */
function fakeDisk(files: Record<string, string>, opts: { caseInsensitive?: boolean } = {}) {
  const disk = new Map(Object.entries(files));
  const key = (p: string) => {
    if (!opts.caseInsensitive) return p;
    for (const k of disk.keys()) if (k.toLowerCase() === p.toLowerCase()) return k;
    return p;
  };
  return {
    getAbstractFileByPath: (p: string) => (disk.has(key(p)) ? { path: key(p) } : null),
    getAllLoadedFiles: () => [...disk.keys()].map((path) => ({ path })),
    adapter: {
      readBinary: (p: string) => {
        const body = disk.get(key(p));
        if (body === undefined) return Promise.reject(new Error(`missing: ${p}`));
        return Promise.resolve(encoder.encode(body));
      },
      writeBinary: (p: string, data: Uint8Array) => {
        disk.set(p, decoder.decode(data));
        return Promise.resolve();
      },
      remove: (p: string) => {
        disk.delete(key(p));
        return Promise.resolve();
      },
      exists: (p: string) => Promise.resolve(disk.has(key(p))),
      stat: (p: string) => Promise.resolve(disk.has(key(p)) ? { size: 1, mtime: 4 } : null),
    },
    disk,
  };
}

type HeadSpec = {
  path: string;
  version: number;
  seq: number;
  /** A rename marker closes `path` and points at `renamedTo`. */
  renamedTo?: string;
  /** The head's content; a marker has none. */
  body?: string;
};

/** One server head, plus the blobs its content needs. */
async function headOf(
  vaultKeys: VaultKeys,
  spec: HeadSpec,
  blobs: Map<string, Uint8Array>,
): Promise<HeadRecord> {
  const pathHash = hashPathHex(vaultKeys.mac_key, spec.path);
  const normalized = normalizeForHash(spec.path, encoder.encode(spec.body ?? ""));
  const chunkHashes: string[] = [];
  for (const part of chunk(normalized)) {
    const hash = blake3Hex(part);
    chunkHashes.push(hash);
    blobs.set(hash, await encryptChunk(part, vaultKeys, hash));
  }
  const meta: FileMeta = {
    path: spec.path,
    mtime: 1,
    size: spec.body?.length ?? 0,
    mime: spec.body === undefined ? "" : "text/markdown",
    plaintext_hash: spec.body === undefined ? "" : blake3Hex(normalized),
    renamed_to: spec.renamedTo,
  };
  return {
    path_hash: pathHash,
    version: spec.version,
    seq: spec.seq,
    enc_metadata: b64encode(await encryptMetadata(meta, vaultKeys, pathHash)),
    chunk_hashes: chunkHashes,
    deleted: spec.renamedTo !== undefined,
    path_ciphertext: null,
    rename_mark: spec.renamedTo === undefined ? 0 : RENAME_MARKER,
  };
}

/** The rebuild exactly as `rebuild-flow.ts` runs it, over a stub server. */
async function rebuild(
  vaultKeys: VaultKeys,
  vault: ReturnType<typeof fakeDisk>,
  heads: HeadRecord[],
  blobs: Map<string, Uint8Array>,
): Promise<{ stats: Awaited<ReturnType<typeof rebuildFromScratch>>; deps: ResyncDeps }> {
  const transport = {
    getBlob: (hash: string) => Promise.resolve(blobs.get(hash)!),
    getHeads: async function* (_afterSeq: number) {
      for (const head of heads) yield head;
    },
    getVersionChain: () => Promise.resolve([]),
  };
  const deps: ResyncDeps = {
    vault: vault as never,
    transport,
    state: openStateDB(),
    keys: vaultKeys,
    vaultId: "vault",
    isSyncable: () => true,
    deviceName: DEVICE,
  };
  const stats = await rebuildFromScratch(deps);
  deps.state.close();
  return { stats, deps };
}

Deno.test("rebuild-rename-carry - a case-only rename makes no conflict copy", async () => {
  const vaultKeys = await keys();
  const OLD = "Cover letter review.md";
  const NEW = "COver letter review.md";
  const BODY = "# cover letter\nsent to the agency\n";
  const vault = fakeDisk({ [NEW]: BODY }, { caseInsensitive: true });
  const blobs = new Map<string, Uint8Array>();
  const heads = [
    await headOf(vaultKeys, { path: OLD, version: 2, seq: 1, renamedTo: NEW }, blobs),
    await headOf(vaultKeys, { path: NEW, version: 1, seq: 2, body: BODY }, blobs),
  ];

  const { stats, deps } = await rebuild(vaultKeys, vault, heads, blobs);

  assertEquals([...vault.disk.keys()], [NEW], "no conflict copy of the same bytes");
  assertEquals(vault.disk.get(NEW), BODY, "the note keeps its content");
  assertEquals(stats.appliedFiles, 1);
  assertEquals(stats.deletedFiles, 1);
  const note = deps.state.getLocalFile(NEW);
  assertEquals(note?.deleted, false, "the note's row stays live");
  assertEquals(note?.last_seen_version, 1, "at the head's version");
  assertEquals(deps.state.getLocalFile(OLD)?.deleted, true, "the old spelling's row is closed");
});

Deno.test("rebuild-rename-carry - a conflict copy carries this device's name", async () => {
  const vaultKeys = await keys();
  const OLD = "notes/draft.md";
  const NEW = "notes/final.md";
  const vault = fakeDisk({ [OLD]: "my edit\n", [NEW]: "their edit\n" });
  const blobs = new Map<string, Uint8Array>();
  const heads = [
    await headOf(vaultKeys, { path: OLD, version: 2, seq: 1, renamedTo: NEW }, blobs),
  ];

  await rebuild(vaultKeys, vault, heads, blobs);

  assertEquals(vault.disk.has(OLD), false, "the renamed-away name is left empty");
  assertEquals(vault.disk.get(NEW), "their edit\n", "the destination keeps its own bytes");
  const copies = [...vault.disk.keys()].filter((path) => path !== NEW);
  assertEquals(copies.length, 1, "the differing edit is kept next to the destination");
  assertEquals(conflictDeviceName(copies[0]), DEVICE, "the name is the device's, not the fallback");
  assertEquals(vault.disk.get(copies[0]), "my edit\n");
});
