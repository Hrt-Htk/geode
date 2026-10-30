// #557: re-key worker two-vault scenario: copy and replace modes, plus
// abort/resume. Device A re-keys; device B unlocks with the NEW passphrase
// and must see byte-identical files, history and trash. The old passphrase
// must no longer verify.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  checkVerifier,
  decryptMetadata,
  decryptPath,
  deriveAuthKey,
  deriveKeys,
  type VaultKeys,
} from "../../core/crypto.ts";
import { hashPathHex, toHex } from "../../core/hash.ts";
import { b64decode } from "../../core/protocol.ts";
import { makeRekeyClient, putVaultAuth } from "../../plugin/plumbing/rekey-client.ts";
import {
  type RekeyCursor,
  type RekeyCursorStore,
  type RekeyProgress,
  runRekey,
} from "../../plugin/sync/rekey-run.ts";
import { pair, TEST_KDF, TestPlugin } from "../two-vault-driver.ts";

const FAST = TEST_KDF;

const authKeyHex = (keys: VaultKeys): string => toHex(deriveAuthKey(keys));

function memoryCursor(): RekeyCursorStore {
  let c: RekeyCursor | null = null;
  return {
    load: () => c,
    save: (x: RekeyCursor) => {
      c = x;
    },
    clear: () => {
      c = null;
    },
  };
}

// note1.md has two versions; note3.md is written then deleted (trash).
async function seed(A: TestPlugin): Promise<void> {
  A.fakeVault.write("note1.md", "hello v1");
  await A.flushPending();
  A.fakeVault.write("note1.md", "hello v2");
  await A.flushPending();
  A.fakeVault.write("note3.md", "third");
  await A.flushPending();
  await A.fakeVault.delete("note3.md");
  await A.flushPending();
}

interface RekeyedFixture {
  A: TestPlugin;
  server: { url: string; db: import("../../server/db.ts").Database };
  vaultId: string;
  salt: Uint8Array;
  newKeys: VaultKeys;
  client: ReturnType<typeof makeRekeyClient>;
  // Fresh devices for the post-rekey join: reusing A/B's device ids would hit
  // the "own version" apply path, which skips disk writes (the file is
  // assumed already local) and leaves the fresh FakeVaults empty.
  deviceIdA2: string;
  tokenA2: string;
  deviceIdB2: string;
  tokenB2: string;
  stop: () => Promise<void>;
}

function addDevice(
  server: { db: import("../../server/db.ts").Database },
  vaultId: string,
  name: string,
): { id: string; token: string } {
  const id = crypto.randomUUID();
  const token = `tok-${id.slice(0, 8)}`;
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    id,
    vaultId,
    name,
    token,
  );
  return { id, token };
}

async function startRekeyedFixture(): Promise<RekeyedFixture> {
  const { A, B, server, vaultId, stop } = await pair();
  await seed(A);
  B.stop();
  const salt = b64decode(A.pluginSettings.salt);
  await putVaultAuth(
    server.url,
    vaultId,
    A.pluginSettings.deviceToken,
    authKeyHex(A.keys),
    server.adminToken,
  );
  const newKeys = await deriveKeys("newpass", salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
  const client = makeRekeyClient(
    server.url,
    vaultId,
    A.pluginSettings.deviceToken,
    authKeyHex(A.keys),
  );
  const a2 = addDevice(server, vaultId, "device-A2");
  const b2 = addDevice(server, vaultId, "device-B2");
  return {
    A,
    server,
    vaultId,
    salt,
    newKeys,
    client,
    deviceIdA2: a2.id,
    tokenA2: a2.token,
    deviceIdB2: b2.id,
    tokenB2: b2.token,
    stop,
  };
}

/** Post-switch assertions shared by every mode/abort variant. */
async function assertRekeyedEndState(f: RekeyedFixture): Promise<void> {
  const { server, vaultId, salt, newKeys } = f;

  // Old passphrase no longer verifies; new one does.
  const row = server.db
    .prepare("SELECT verifier, argon2_ops, argon2_mem FROM vaults WHERE id = ?")
    .get(vaultId) as { verifier: string; argon2_ops: number; argon2_mem: number };
  assertEquals(row.argon2_ops, FAST.ops);
  assertEquals(row.argon2_mem, FAST.mem);
  assert(
    !(await checkVerifier(
      await deriveKeys("test", salt, { opsLimit: FAST.ops, memLimit: FAST.mem }),
      b64decode(row.verifier),
    )),
  );
  assert(await checkVerifier(newKeys, b64decode(row.verifier)));

  // A re-joins with the new passphrase and cold-syncs byte-identical content.
  f.A.stop();
  const A2 = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId: f.deviceIdA2,
    deviceToken: f.tokenA2,
    passphrase: "newpass",
    saltBytes: salt,
  });
  await A2.start();
  await A2.waitForVersion("note1.md", 2);
  assertEquals(new TextDecoder().decode(A2.fakeVault.files.get("note1.md")!), "hello v2");
  assert(!A2.fakeVault.fileExists("note3.md"));

  // History: the version chain lives under the NEW path hash and decrypts
  // with the new keys.
  const newClient = makeRekeyClient(server.url, vaultId, f.tokenA2, authKeyHex(newKeys));
  const hash1 = hashPathHex(newKeys.mac_key, "note1.md");
  const chain1 = await newClient.versionChain(hash1);
  assertEquals(chain1.length, 2);
  for (const v of chain1) {
    assertEquals(
      (await decryptMetadata(b64decode(v.enc_metadata), newKeys, hash1)).path,
      "note1.md",
    );
  }
  const hash3 = hashPathHex(newKeys.mac_key, "note3.md");
  const chain3 = await newClient.versionChain(hash3);
  assertEquals(chain3.length, 2);
  assertEquals(chain3.at(0)!.deleted, 1); // tombstone head (chain is version-DESC)

  // Trash: re-keyed head, decryptable with the new keys.
  const trash = await newClient.trash();
  assertEquals(trash.length, 1);
  assertEquals(trash[0].path_hash, hash3);
  const headJson = JSON.parse(trash[0].head_json) as {
    enc_metadata: string;
    path_ciphertext: string | null;
  };
  assertEquals(
    (await decryptMetadata(b64decode(headJson.enc_metadata), newKeys, hash3)).path,
    "note3.md",
  );
  assert(headJson.path_ciphertext);
  assertEquals(await decryptPath(b64decode(headJson.path_ciphertext!), newKeys, hash3), "note3.md");

  // B unlocks with the new passphrase and converges to the same bytes.
  const B2 = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId: f.deviceIdB2,
    deviceToken: f.tokenB2,
    passphrase: "newpass",
    saltBytes: salt,
  });
  await B2.start();
  await A2.waitForConvergence(B2, "note1.md");
  assertEquals(new TextDecoder().decode(B2.fakeVault.files.get("note1.md")!), "hello v2");
  B2.stop();
  A2.stop();
}

Deno.test("rekey copy mode: B unlocks with the new passphrase, identical content/history/trash", async () => {
  const f = await startRekeyedFixture();
  try {
    await runRekey({
      oldKeys: f.A.keys,
      newKeys: f.newKeys,
      params: FAST,
      mode: "copy",
      client: f.client,
      cursor: memoryCursor(),
    });
    await assertRekeyedEndState(f);
  } finally {
    await f.stop();
  }
});

Deno.test("rekey replace mode: B unlocks with the new passphrase, identical content/history/trash", async () => {
  const f = await startRekeyedFixture();
  try {
    await runRekey({
      oldKeys: f.A.keys,
      newKeys: f.newKeys,
      params: FAST,
      mode: "replace",
      client: f.client,
      cursor: memoryCursor(),
    });
    await assertRekeyedEndState(f);
  } finally {
    await f.stop();
  }
});

Deno.test("rekey: a run aborted mid-blobs resumes to the same end state", async () => {
  const f = await startRekeyedFixture();
  try {
    const cursor = memoryCursor();
    const ac = new AbortController();
    let aborted = false;
    const onProgress = (p: RekeyProgress) => {
      if (!aborted && p.phase === "blobs" && p.done >= 1) {
        aborted = true;
        ac.abort();
      }
    };
    await assertRejects(
      () =>
        runRekey({
          oldKeys: f.A.keys,
          newKeys: f.newKeys,
          params: FAST,
          mode: "copy",
          client: f.client,
          cursor,
          onProgress,
          signal: ac.signal,
        }),
      Error,
      "abort",
    );
    await runRekey({
      oldKeys: f.A.keys,
      newKeys: f.newKeys,
      params: FAST,
      mode: "copy",
      client: f.client,
      cursor,
    });
    await assertRekeyedEndState(f);
  } finally {
    await f.stop();
  }
});

// #557 review finding 1: in replace mode a path's chain must never straddle
// two row batches: the batch rewrites rows in place, so a chain split across
// batches leaves a crash window where the head is under the new path hash but
// the tail is still under the old one (unreachable on resume). This seeds a
// chain longer than ROW_BATCH (50) and aborts right after it is posted.
Deno.test("rekey replace mode: a long chain survives a mid-rows abort/resume", async () => {
  const { A, B, server, vaultId, stop } = await pair();
  try {
    // 60 versions of one file: longer than the 50-row batch.
    for (let i = 1; i <= 60; i++) {
      A.fakeVault.write("long.md", `long v${i.toString().padStart(2, "0")}`);
      await A.flushPending();
    }
    A.fakeVault.write("note3.md", "third");
    await A.flushPending();
    await A.fakeVault.delete("note3.md");
    await A.flushPending();
    B.stop();
    const salt = b64decode(A.pluginSettings.salt);
    await putVaultAuth(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      authKeyHex(A.keys),
      server.adminToken,
    );
    const newKeys = await deriveKeys("newpass", salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
    const client = makeRekeyClient(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      authKeyHex(A.keys),
    );
    const cursor = memoryCursor();
    const ac = new AbortController();
    let aborted = false;
    const onProgress = (p: RekeyProgress) => {
      if (!aborted && p.phase === "rows" && p.done >= 60) {
        aborted = true;
        ac.abort();
      }
    };
    await assertRejects(
      () =>
        runRekey({
          oldKeys: A.keys,
          newKeys,
          params: FAST,
          mode: "replace",
          client,
          cursor,
          onProgress,
          signal: ac.signal,
        }),
      Error,
      "abort",
    );
    await runRekey({
      oldKeys: A.keys,
      newKeys,
      params: FAST,
      mode: "replace",
      client,
      cursor,
    });

    // Every version of the long chain must be readable under the new keys.
    const newClient = makeRekeyClient(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      authKeyHex(newKeys),
    );
    const hashLong = hashPathHex(newKeys.mac_key, "long.md");
    const chain = await newClient.versionChain(hashLong);
    assertEquals(chain.length, 60);
    for (const v of chain) {
      assertEquals(
        (await decryptMetadata(b64decode(v.enc_metadata), newKeys, hashLong)).path,
        "long.md",
      );
    }
    // The vault is switchable: old passphrase dead, new passphrase works.
    const row = server.db
      .prepare("SELECT verifier FROM vaults WHERE id = ?")
      .get(vaultId) as { verifier: string };
    assert(
      !(await checkVerifier(
        await deriveKeys("test", salt, { opsLimit: FAST.ops, memLimit: FAST.mem }),
        b64decode(row.verifier),
      )),
    );
    assert(await checkVerifier(newKeys, b64decode(row.verifier)));
  } finally {
    await stop();
  }
});

Deno.test("rekey: a run aborted mid-rows resumes to the same end state", async () => {
  const f = await startRekeyedFixture();
  try {
    const cursor = memoryCursor();
    const ac = new AbortController();
    let aborted = false;
    const onProgress = (p: RekeyProgress) => {
      if (!aborted && p.phase === "rows" && p.done >= 1) {
        aborted = true;
        ac.abort();
      }
    };
    await assertRejects(
      () =>
        runRekey({
          oldKeys: f.A.keys,
          newKeys: f.newKeys,
          params: FAST,
          mode: "copy",
          client: f.client,
          cursor,
          onProgress,
          signal: ac.signal,
        }),
      Error,
      "abort",
    );
    await runRekey({
      oldKeys: f.A.keys,
      newKeys: f.newKeys,
      params: FAST,
      mode: "copy",
      client: f.client,
      cursor,
    });
    await assertRekeyedEndState(f);
  } finally {
    await f.stop();
  }
});
