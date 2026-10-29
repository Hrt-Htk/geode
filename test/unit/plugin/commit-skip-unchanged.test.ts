import { assert, assertEquals } from "@std/assert";
import { commitFileBytes } from "../../../plugin/sync/commit.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { blake3Hex, hashPathHex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

function makeTransport() {
  const calls = { headBlob: 0, putBlob: 0, commit: 0 };
  const transport = {
    headBlob: () => {
      calls.headBlob++;
      return false;
    },
    putBlob: () => {
      calls.putBlob++;
    },
    commit: () => {
      calls.commit++;
      return { kind: "ack" as const, seq: 1, version: 1 };
    },
  };
  return { transport, calls };
}

Deno.test("commit-skip-unchanged - unchanged content never uploads chunks", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();

  const path = "note.md";
  const body = new TextEncoder().encode("hello world");
  const plaintextHash = blake3Hex(normalizeForHash(path, body));
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: body.length,
    mtime: 1,
    plaintext_hash: plaintextHash,
    last_seen_version: 1,
    chunk_hashes: [],
  });

  const { transport, calls } = makeTransport();
  await commitFileBytes(path, body, 2, {
    pendingRenameTarget: () => undefined,
    vault: {} as never,
    state,
    keys,
    transport: transport as never,
    onConflict: async () => {},
  });

  // Skip must happen BEFORE any blob HEAD/PUT or commit.
  assertEquals(calls.headBlob, 0);
  assertEquals(calls.putBlob, 0);
  assertEquals(calls.commit, 0);

  state.close();
});

Deno.test("commit-skip-unchanged - a deleted local file is still committed even when the hash matches", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();

  const path = "note.md";
  const body = new TextEncoder().encode("hello world");
  const plaintextHash = blake3Hex(normalizeForHash(path, body));
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: body.length,
    mtime: 1,
    plaintext_hash: plaintextHash,
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: true,
  });

  const { transport, calls } = makeTransport();
  await commitFileBytes(path, body, 2, {
    pendingRenameTarget: () => undefined,
    vault: {} as never,
    state,
    keys,
    transport: transport as never,
    onConflict: async () => {},
  });

  assert(
    calls.commit > 0,
    "a deleted local file must not be skipped by the unchanged-content check",
  );

  state.close();
});

Deno.test("commit-skip-unchanged - the merge caller (force) commits even when content is unchanged", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();

  const path = "note.md";
  const body = new TextEncoder().encode("hello world");
  const plaintextHash = blake3Hex(normalizeForHash(path, body));
  const pathHash = hashPathHex(keys.mac_key, path);
  state.upsertLocalFile({
    path,
    path_hash: pathHash,
    size: body.length,
    mtime: 1,
    plaintext_hash: plaintextHash,
    last_seen_version: 1,
    chunk_hashes: [],
  });

  const { transport, calls } = makeTransport();
  await commitFileBytes(path, body, 2, {
    pendingRenameTarget: () => undefined,
    vault: {} as never,
    state,
    keys,
    transport: transport as never,
    onConflict: async () => {},
  }, { force: true });

  assert(
    calls.commit > 0,
    "a merge-collapsed commit must not be skipped by the unchanged-content check",
  );

  state.close();
});
