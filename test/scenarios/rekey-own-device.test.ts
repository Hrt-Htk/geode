// #53: the device that ran the re-key: its rows hold the old path hashes when the session
// restarts. Older files must still delete and rename, and a row already stale with its
// file missing restores the file: a repair never lets a delete made under the old hash land.
import { assert, assertEquals } from "@std/assert";
import { deriveAuthKey, deriveKeys, makeVerifier, type VaultKeys } from "../../core/crypto.ts";
import { hashPathHex, toHex } from "../../core/hash.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";
import { makeRekeyClient, putVaultAuth } from "../../plugin/plumbing/rekey-client.ts";
import { finishRekey } from "../../plugin/plumbing/vault-lock.ts";
import { runRekey } from "../../plugin/sync/rekey-run.ts";
import { headOf, memoryCursor, pair, TEST_KDF, waitFor } from "../two-vault-driver.ts";

/** A runs a replace re-key and comes back the way the real modal brings it back, through
 * `finishRekey`; B unlocks through the passphrase-changed path. */
async function rekeyedOnA() {
  const fixture = await pair();
  const { A, B, server, vaultId } = fixture;
  A.fakeVault.write("older.md", "saved before the re-key");
  await A.flushPending();
  A.fakeVault.write("gone.md", "deleted while offline");
  await A.flushPending();
  await B.waitForVersion("older.md", 1);
  await B.waitForVersion("gone.md", 1);

  const oldKeys: VaultKeys = A.keys!;
  const verifierB64 = b64encode(await makeVerifier(oldKeys));
  server.db.run(
    "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ? WHERE id = ?",
    verifierB64,
    TEST_KDF.ops,
    TEST_KDF.mem,
    vaultId,
  );
  A.pluginSettings = { ...A.pluginSettings, verifier: verifierB64 };
  B.pluginSettings = { ...B.pluginSettings, verifier: verifierB64 };

  const authKeyHex = toHex(deriveAuthKey(oldKeys));
  await putVaultAuth(
    server.url,
    vaultId,
    A.pluginSettings.deviceToken,
    authKeyHex,
    server.adminToken,
  );
  const salt = b64decode(A.pluginSettings.salt);
  const newKeys = await deriveKeys("newpass", salt, {
    opsLimit: TEST_KDF.ops,
    memLimit: TEST_KDF.mem,
  });
  const { verifierB64: newVerifier } = await runRekey({
    oldKeys,
    newKeys,
    params: TEST_KDF,
    mode: "replace",
    client: makeRekeyClient(server.url, vaultId, A.pluginSettings.deviceToken, authKeyHex),
    cursor: memoryCursor(),
  });

  await finishRekey(A, newKeys, TEST_KDF, newVerifier);
  A.rekeyElsewhere = false;
  await waitFor(() => A.isLive(), "A to go live under the new keys");
  await A.syncManager!.startReconciler();

  await waitFor(() => B.rekeyElsewhere, "B to enter the passphrase changed elsewhere state");
  await B.unlock("newpass");
  return { ...fixture, oldKeys, newKeys };
}

Deno.test("rekey own device: a delete of a file saved before the re-key reaches the other device", async () => {
  const { A, B, server, vaultId, newKeys, stop } = await rekeyedOnA();
  try {
    await A.fakeVault.delete("older.md");
    await A.flushPending();
    await B.waitForDeleted("older.md");
    assertEquals(
      headOf(server, vaultId, hashPathHex(newKeys.mac_key, "older.md"))?.deleted,
      1,
    );
  } finally {
    await stop();
  }
});

Deno.test("rekey own device: a rename of a file saved before the re-key leaves only the new name", async () => {
  const { A, B, stop } = await rekeyedOnA();
  try {
    A.fakeVault.rename("older.md", "moved.md");
    await A.flushPending();
    await B.waitForVersion("moved.md", 1);
    await B.waitForDeleted("older.md");
    assert(!B.fakeVault.fileExists("older.md"));
  } finally {
    await stop();
  }
});

Deno.test("rekey own device: a row already stale with its file missing restores the file and removes nothing", async () => {
  const { A, B, server, vaultId, oldKeys, newKeys, stop } = await rekeyedOnA();
  try {
    // A notebook an earlier version left stale, with a delete that kept bouncing.
    for (const path of ["older.md", "gone.md"]) {
      const row = A.state!.getLocalFile(path)!;
      A.state!.upsertLocalFile({ ...row, path_hash: hashPathHex(oldKeys.mac_key, path) });
    }
    A.stop();
    await A.fakeVault.delete("gone.md");
    await A.restartUnlockedSession();
    await waitFor(() => A.isLive(), "A to go live again");
    await A.syncManager!.startReconciler();
    await A.flushPending();

    assertEquals(
      new TextDecoder().decode(A.fakeVault.files.get("gone.md")!),
      "deleted while offline",
    );
    const goneHash = hashPathHex(newKeys.mac_key, "gone.md");
    assertEquals(headOf(server, vaultId, goneHash), { version: 1, deleted: 0 });
    assert(B.fakeVault.fileExists("gone.md"));
    assertEquals(A.state!.getLocalFile("gone.md")!.path_hash, goneHash);
    // The file that never left only gets its name corrected.
    assertEquals(
      A.state!.getLocalFile("older.md")!.path_hash,
      hashPathHex(newKeys.mac_key, "older.md"),
    );
  } finally {
    await stop();
  }
});

Deno.test("rekey own device: a stale row with no version of its own never opens a chain under the old hash", async () => {
  const { A, B, server, vaultId, oldKeys, newKeys, stop } = await rekeyedOnA();
  try {
    // A rename destination whose note never committed: version 0, and the server has
    // nothing at this name. Its parent 0 matches an empty chain, so a delete would land.
    A.stop();
    const hash = hashPathHex(oldKeys.mac_key, "carried.md");
    await A.restartUnlockedSession();
    A.state!.upsertLocalFile({
      path: "carried.md",
      path_hash: hash,
      size: 1,
      mtime: 1,
      plaintext_hash: "carried",
      last_seen_version: 0,
      chunk_hashes: [],
      deleted: false,
    });
    await waitFor(() => A.isLive(), "A to go live again");
    await A.syncManager!.startReconciler();
    await A.reconcileNow();
    await A.flushPending();
    assertEquals(headOf(server, vaultId, hash), null, "no tombstone under the old hash");

    // B can still use the name: an orphan tombstone would leave it unable to commit here.
    B.fakeVault.write("carried.md", "written on B");
    await B.flushPending();
    await A.waitForVersion("carried.md", 1);
    assertEquals(headOf(server, vaultId, hashPathHex(newKeys.mac_key, "carried.md")), {
      version: 1,
      deleted: 0,
    });
    assertEquals(
      A.state!.getLocalFile("carried.md")!.path_hash,
      hashPathHex(newKeys.mac_key, "carried.md"),
    );
  } finally {
    await stop();
  }
});
