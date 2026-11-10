// #55: a rebuild that re-applies a rename marker must not turn a case-only rename into a
// conflict copy, and a copy it does make carries this device's name, never "This device".

import { assertEquals } from "@std/assert";
import type { HeadRecord } from "../../../core/protocol.ts";
import { deriveKeys, type VaultKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import type { StateDB } from "../../../plugin/plumbing/state.ts";
import { openSessionStateDB } from "../../helpers/state.ts";
import { rebuildFromScratch, type ResyncDeps } from "../../../plugin/sync/recovery.ts";
import { conflictDeviceName } from "../../../plugin/sync/conflicts.ts";
import { diskVault } from "../../helpers/disk-vault.ts";
import { headRecord } from "../../helpers/head-record.ts";

const SALT = new Uint8Array(16);
const PASS = "rebuild-rename-carry";
const DEVICE = "Laptop";

async function keys(): Promise<VaultKeys> {
  return await deriveKeys(PASS, SALT, { opsLimit: 1, memLimit: 8192 });
}

/** The rebuild exactly as `rebuild-flow.ts` runs it, over a stub server. The caller owns
 * the returned state and closes it. */
async function rebuild(
  vaultKeys: VaultKeys,
  vault: ReturnType<typeof diskVault>,
  heads: HeadRecord[],
  state: StateDB,
  blobs: Map<string, Uint8Array>,
): Promise<Awaited<ReturnType<typeof rebuildFromScratch>>> {
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
    state,
    keys: vaultKeys,
    vaultId: "vault",
    isSyncable: () => true,
    deviceName: DEVICE,
  };
  return await rebuildFromScratch(deps);
}

Deno.test("rebuild-rename-carry - a case-only rename makes no conflict copy", async () => {
  const vaultKeys = await keys();
  const OLD = "Cover letter review.md";
  const NEW = "COver letter review.md";
  const BODY = "# cover letter\nsent to the agency\n";
  const vault = diskVault({ [NEW]: BODY }, { caseInsensitive: true });
  const blobs = new Map<string, Uint8Array>();
  const heads = [
    await headRecord(vaultKeys, { path: OLD, version: 2, seq: 1, renamedTo: NEW }, blobs),
    await headRecord(vaultKeys, { path: NEW, version: 1, seq: 2, body: BODY }, blobs),
  ];

  const state = openSessionStateDB();
  try {
    const stats = await rebuild(vaultKeys, vault, heads, state, blobs);

    assertEquals([...vault.disk.keys()], [NEW], "no conflict copy of the same bytes");
    assertEquals(vault.disk.get(NEW), BODY, "the note keeps its content");
    assertEquals(stats.appliedFiles, 1);
    assertEquals(stats.deletedFiles, 1);
    const note = state.getLocalFile(NEW);
    assertEquals(note?.deleted, false, "the note's row stays live");
    assertEquals(note?.last_seen_version, 1, "at the head's version");
    assertEquals(state.getLocalFile(OLD)?.deleted, true, "the old spelling's row is closed");
  } finally {
    state.close();
  }
});

Deno.test("rebuild-rename-carry - a live destination row still closes the same-bytes rename", async () => {
  const vaultKeys = await keys();
  const OLD = "Cover letter review.md";
  const NEW = "COver letter review.md";
  const BODY = "# cover letter\nsent to the agency\n";
  const vault = diskVault({ [NEW]: BODY }, { caseInsensitive: true });
  const blobs = new Map<string, Uint8Array>();
  const heads = [
    await headRecord(vaultKeys, { path: OLD, version: 2, seq: 1, renamedTo: NEW }, blobs),
    await headRecord(vaultKeys, { path: NEW, version: 1, seq: 2, body: BODY }, blobs),
  ];
  const state = openSessionStateDB();
  try {
    // The destination's head applied first (heads run 8 at a time), so its row is live when
    // the marker lands: the bytes decide, not the row, or this would keep a copy again.
    state.upsertLocalFile({
      path: NEW,
      path_hash: hashPathHex(vaultKeys.mac_key, NEW),
      size: BODY.length,
      mtime: 1,
      plaintext_hash: blake3Hex(normalizeForHash(NEW, new TextEncoder().encode(BODY))),
      last_seen_version: 1,
      chunk_hashes: [],
    });

    await rebuild(vaultKeys, vault, heads, state, blobs);

    assertEquals([...vault.disk.keys()], [NEW], "no conflict copy");
    assertEquals(vault.disk.get(NEW), BODY, "the note keeps its content");
    assertEquals(state.getLocalFile(OLD)?.deleted, true, "the old spelling's row is closed");
    assertEquals(state.getLocalFile(NEW)?.deleted, false, "the live row stays live");
  } finally {
    state.close();
  }
});

Deno.test("rebuild-rename-carry - a conflict copy carries this device's name", async () => {
  const vaultKeys = await keys();
  const OLD = "notes/draft.md";
  const NEW = "notes/final.md";
  const vault = diskVault({ [OLD]: "my edit\n", [NEW]: "their edit\n" });
  const blobs = new Map<string, Uint8Array>();
  const heads = [
    await headRecord(vaultKeys, { path: OLD, version: 2, seq: 1, renamedTo: NEW }, blobs),
  ];

  const state = openSessionStateDB();
  try {
    await rebuild(vaultKeys, vault, heads, state, blobs);
  } finally {
    state.close();
  }

  assertEquals(vault.disk.has(OLD), false, "the renamed-away name is left empty");
  assertEquals(vault.disk.get(NEW), "their edit\n", "the destination keeps its own bytes");
  const copies = [...vault.disk.keys()].filter((path) => path !== NEW);
  assertEquals(copies.length, 1, "the differing edit is kept next to the destination");
  assertEquals(conflictDeviceName(copies[0]), DEVICE, "the name is the device's, not the fallback");
  assertEquals(vault.disk.get(copies[0]), "my edit\n");
});
