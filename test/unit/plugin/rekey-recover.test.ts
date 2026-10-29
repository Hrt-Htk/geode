// #560: unlock after the passphrase changed on another device: fetch the
// vault's current salt/verifier/params, derive with the NEW params (Rule 7),
// verify, and rebuild local path hashes (rows keep version + plaintext hash).
import { assert, assertEquals } from "@std/assert";
import { checkVerifier, deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";
import { b64encode } from "../../../core/protocol.ts";
import { setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";
import { type LocalFileRow, openStateDB } from "../../../plugin/plumbing/state.ts";
import {
  rebuildLocalFileRows,
  unlockAfterRemoteRekey,
} from "../../../plugin/sync/rekey-recover.ts";

const FAST = { opsLimit: 1, memLimit: 8192 };

function row(overrides: Partial<LocalFileRow> = {}): LocalFileRow {
  return {
    path: "Notes/a.md",
    path_hash: "oldhash",
    size: 10,
    mtime: 1,
    plaintext_hash: "p1",
    last_seen_version: 3,
    chunk_hashes: ["c1", "c2"],
    deleted: false,
    ...overrides,
  };
}

function stubVaultInfo(info: Record<string, unknown>): void {
  setHttpImpl(({ url, method }) => {
    assert(url.endsWith("/info"), `expected the vault info route, got ${url}`);
    assertEquals(method, "GET");
    return Promise.resolve({ status: 200, text: JSON.stringify(info) });
  });
}

Deno.test("rekey-recover - rebuild replaces only path_hash", async () => {
  const newKeys = await deriveKeys("new", new Uint8Array(16), FAST);
  const rows = [
    row(),
    row({ path: "b.png", deleted: true, last_seen_version: 7, chunk_hashes: ["c9"] }),
  ];
  const rebuilt = rebuildLocalFileRows(rows, newKeys);
  assertEquals(rebuilt.length, 2);
  for (let i = 0; i < rows.length; i++) {
    const r = rebuilt[i];
    assertEquals(r.path_hash, hashPathHex(newKeys.mac_key, rows[i].path));
    assert(r.path_hash !== rows[i].path_hash, "path_hash must change under the new mac key");
    assertEquals(r.path, rows[i].path);
    assertEquals(r.size, rows[i].size);
    assertEquals(r.mtime, rows[i].mtime);
    assertEquals(r.plaintext_hash, rows[i].plaintext_hash);
    assertEquals(r.last_seen_version, rows[i].last_seen_version);
    assertEquals(r.chunk_hashes, rows[i].chunk_hashes);
    assertEquals(r.deleted, rows[i].deleted);
  }
});

Deno.test("rekey-recover - unlock verifies with the new params and rebuilds the state rows", async () => {
  const salt = new Uint8Array(16);
  const newKeys = await deriveKeys("newpass", salt, { opsLimit: 5, memLimit: 16384 });
  const verifierB64 = b64encode(await makeVerifier(newKeys));
  stubVaultInfo({ salt: b64encode(salt), verifier: verifierB64, argon2_ops: 5, argon2_mem: 16384 });

  const state = openStateDB([row(), row({ path: "b.png", last_seen_version: 7 })]);
  state.updateSyncCursor(42);
  const result = await unlockAfterRemoteRekey({
    serverUrl: "http://geode.test",
    vaultId: "vault-1",
    deviceToken: "admin",
    passphrase: "newpass",
    state,
  });

  // Keys verify against the server's verifier.
  assert(await checkVerifier(result.keys, b64decodeLocal(verifierB64)));
  // Rows rebuilt under the new mac key; versions, plaintext hashes and the
  // sync cursor are untouched.
  const a = state.getLocalFile("Notes/a.md")!;
  assertEquals(a.path_hash, hashPathHex(newKeys.mac_key, "Notes/a.md"));
  assertEquals(a.last_seen_version, 3);
  assertEquals(a.plaintext_hash, "p1");
  assertEquals(a.chunk_hashes, ["c1", "c2"]);
  const b = state.getLocalFile("b.png")!;
  assertEquals(b.path_hash, hashPathHex(newKeys.mac_key, "b.png"));
  assertEquals(b.last_seen_version, 7);
  assertEquals(state.getSyncCursor(), 42);
  assertEquals(result.verifierB64, verifierB64);
  assertEquals(result.argon2Params, { ops: 5, mem: 16384 });
});

Deno.test("rekey-recover - a wrong passphrase is refused", async () => {
  const salt = new Uint8Array(16);
  const newKeys = await deriveKeys("newpass", salt, FAST);
  const verifierB64 = b64encode(await makeVerifier(newKeys));
  stubVaultInfo({ salt: b64encode(salt), verifier: verifierB64, argon2_ops: 1, argon2_mem: 8192 });
  const state = openStateDB([row()]);
  await assertRejectsLocal(
    () =>
      unlockAfterRemoteRekey({
        serverUrl: "http://geode.test",
        vaultId: "vault-1",
        deviceToken: "admin",
        passphrase: "oldpass",
        state,
      }),
    "incorrect passphrase",
  );
  // The state is left untouched.
  assertEquals(state.getLocalFile("Notes/a.md")!.path_hash, "oldhash");
});

function b64decodeLocal(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function assertRejectsLocal(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert((e as Error).message.includes(msg), `expected "${msg}", got ${(e as Error).message}`);
    return;
  }
  throw new Error(`expected rejection with "${msg}"`);
}
