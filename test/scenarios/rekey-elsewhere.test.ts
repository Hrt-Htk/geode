// #560: other devices after a re-key: A re-keys while B is connected
// throughout. B is stopped (passphrase changed elsewhere), never commits
// old-key data, unlocks with the new passphrase, converges without a
// re-download, and its next edit commits under the new keys which A reads.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { deriveAuthKey, deriveKeys, makeVerifier } from "../../core/crypto.ts";
import { hashPathHex, toHex } from "../../core/hash.ts";
import { b64decode, b64encode } from "../../core/protocol.ts";
import { makeRekeyClient, putVaultAuth } from "../../plugin/plumbing/rekey-client.ts";
import { type RekeyCursor, type RekeyCursorStore, runRekey } from "../../plugin/sync/rekey-run.ts";
import { pair, restartPlugin, TEST_KDF, waitFor } from "../two-vault-driver.ts";

const FAST = TEST_KDF;

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

function versionRowCount(db: import("../../server/db.ts").Database, vaultId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { n: number }).n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("rekey elsewhere: B is stopped, never commits old-key data, unlocks, converges", async () => {
  const { A, B, server, vaultId, stop } = await pair();
  try {
    // Two files, note1 with two versions, both devices fully in sync.
    A.fakeVault.write("note1.md", "hello v1");
    await A.flushPending();
    A.fakeVault.write("note1.md", "hello v2");
    await A.flushPending();
    A.fakeVault.write("note2.md", "second");
    await A.flushPending();
    await B.waitForVersion("note1.md", 2);
    await B.waitForVersion("note2.md", 1);

    // The vault has a verifier and both devices store it (their hello_ack
    // hash matches, so a plain reconnect is "ok").
    const salt = b64decode(A.pluginSettings.salt);
    const oldKeys = A.keys;
    const verifierB64 = b64encode(await makeVerifier(oldKeys));
    server.db.run(
      "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ? WHERE id = ?",
      verifierB64,
      FAST.ops,
      FAST.mem,
      vaultId,
    );
    A.pluginSettings = { ...A.pluginSettings, verifier: verifierB64 };
    B.pluginSettings = { ...B.pluginSettings, verifier: verifierB64 };

    const rowsBeforeRekey = versionRowCount(server.db, vaultId);

    // A re-keys (replace mode) while B stays connected.
    const authKeyHex = toHex(deriveAuthKey(oldKeys));
    await putVaultAuth(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      authKeyHex,
      server.adminToken,
    );
    const newKeys = await deriveKeys("newpass", salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
    const client = makeRekeyClient(server.url, vaultId, A.pluginSettings.deviceToken, authKeyHex);
    await runRekey({
      oldKeys,
      newKeys,
      params: FAST,
      mode: "replace",
      client,
      cursor: memoryCursor(),
    });

    // The switch closed both sockets; the reconnect read the new verifier
    // hash and both devices entered the locked state (B is the assertion
    // target; A must unlock too before it can read B's edit).
    await waitFor(() => B.rekeyElsewhere, "B to enter the passphrase changed elsewhere state");
    assertEquals(B.transport, null, "B's runtime must be disposed (transport stopped)");
    await waitFor(() => A.rekeyElsewhere, "A to enter the passphrase changed elsewhere state");

    // B attempts an edit while locked: it must never commit old-key data.
    B.fakeVault.write("note2.md", "second, edited by locked B");
    await sleep(500);
    assertEquals(
      versionRowCount(server.db, vaultId),
      rowsBeforeRekey,
      "locked B must not commit any rows",
    );

    // B unlocks with the new passphrase and resumes from the kept cursor.
    // (The real lock path disposed the runtime, so the in-memory pending op
    // for the locked edit is gone with it: the next edit commits.)
    await B.unlock("newpass");
    // A unlocks too, so it can read B's next edit.
    await A.unlock("newpass");

    // B's next edit commits under the NEW keys.
    B.fakeVault.write("note3.md", "third, from B after unlock");
    await B.flushPending();
    await A.waitForVersion("note3.md", 1);
    assertEquals(
      new TextDecoder().decode(A.fakeVault.files.get("note3.md")!),
      "third, from B after unlock",
    );

    // B's edit committed under the NEW path hash, and B kept its cursor
    // (no re-download: note1's row still points at version 2).
    const hash3 = hashPathHex(newKeys.mac_key, "note3.md");
    const row3 = server.db
      .prepare("SELECT path_hash FROM file_versions WHERE vault_id = ? AND path_hash = ?")
      .get(vaultId, hash3) as { path_hash: string } | undefined;
    assert(row3, "B's edit must commit under the new path hash");
    assertEquals(B.state!.getLocalFile("note1.md")!.last_seen_version, 2);
    assertEquals(
      B.state!.getLocalFile("note1.md")!.path_hash,
      hashPathHex(newKeys.mac_key, "note1.md"),
    );
  } finally {
    await stop();
  }
});

// Seeds a two-file vault with a verifier and runs a replace re-key to
// "newpass" while both devices stay connected; both end up locked.
async function rekeyedPair() {
  const { A, B, server, vaultId, stop } = await pair();
  A.fakeVault.write("note1.md", "hello v1");
  await A.flushPending();
  A.fakeVault.write("note1.md", "hello v2");
  await A.flushPending();
  A.fakeVault.write("note2.md", "second");
  await A.flushPending();
  await B.waitForVersion("note1.md", 2);
  await B.waitForVersion("note2.md", 1);

  const salt = b64decode(A.pluginSettings.salt);
  const oldKeys = A.keys!;
  const verifierB64 = b64encode(await makeVerifier(oldKeys));
  server.db.run(
    "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ? WHERE id = ?",
    verifierB64,
    FAST.ops,
    FAST.mem,
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
  const newKeys = await deriveKeys("newpass", salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
  const client = makeRekeyClient(server.url, vaultId, A.pluginSettings.deviceToken, authKeyHex);
  await runRekey({
    oldKeys,
    newKeys,
    params: FAST,
    mode: "replace",
    client,
    cursor: memoryCursor(),
  });

  await waitFor(() => B.rekeyElsewhere, "B to enter the passphrase changed elsewhere state");
  await waitFor(() => A.rekeyElsewhere, "A to enter the passphrase changed elsewhere state");
  return { A, B, server, vaultId, stop };
}

Deno.test("rekey elsewhere: restart before unlock - the new passphrase unlocks via the server verifier", async () => {
  const { A, B, server, stop } = await rekeyedPair();
  try {
    // B restarts Obsidian before unlocking: the in-memory rekeyElsewhere flag
    // is gone, the key cache was cleared at lock, and the local verifier is
    // stale. The correct NEW passphrase must still unlock (the local check
    // fails and falls back to the server's current verifier).
    const B2 = await restartPlugin(B, server, { unlocked: false });
    assertEquals(B2.rekeyElsewhere, false, "the in-memory flag is gone after a restart");

    await assertRejects(
      () => B2.unlock("wrongpass"),
      Error,
      "incorrect passphrase",
      "a wrong passphrase is still rejected",
    );
    await B2.unlock("newpass");

    // A unlocks too, so the pair can sync again.
    await A.unlock("newpass");

    // B2 syncs under the new keys in both directions.
    A.fakeVault.write("note4.md", "after restart");
    await A.flushPending();
    await B2.waitForVersion("note4.md", 1);
    B2.fakeVault.write("note5.md", "from B2 after restart");
    await B2.flushPending();
    await A.waitForVersion("note5.md", 1);
    assertEquals(
      new TextDecoder().decode(A.fakeVault.files.get("note5.md")!),
      "from B2 after restart",
    );
  } finally {
    await stop();
  }
});

Deno.test("rekey elsewhere: a cancelled re-key resumes paused devices on reconnect", async () => {
  const { A, B, server, vaultId, stop } = await pair();
  try {
    A.fakeVault.write("note1.md", "hello");
    await A.flushPending();
    await B.waitForVersion("note1.md", 1);

    // A starts a copy re-key session and cancels it (no switch): the vault
    // stays on the old keys, but both devices paused for the session.
    const authKeyHex = toHex(deriveAuthKey(A.keys!));
    await putVaultAuth(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      authKeyHex,
      server.adminToken,
    );
    const client = makeRekeyClient(server.url, vaultId, A.pluginSettings.deviceToken, authKeyHex);
    await client.startSession("copy");

    await waitFor(() => B.rekeyInProgress, "B to pause for the re-key");
    await waitFor(() => A.rekeyInProgress, "A to pause for the re-key");

    await client.cancel();

    // The next reconnect reads rekey:false + a matching verifier hash → "ok":
    // the paused session must restart so sync actually resumes (resume() alone
    // would leave the reconciler dead: its "live" event already fired).
    B.disconnect();
    await B.reconnect();
    assertEquals(B.rekeyInProgress, false);
    A.disconnect();
    await A.reconnect();
    assertEquals(A.rekeyInProgress, false);

    // Sync is resumed: A's next write reaches B.
    A.fakeVault.write("note2.md", "after cancel");
    await A.flushPending();
    await B.waitForVersion("note2.md", 1);
    assertEquals(
      new TextDecoder().decode(B.fakeVault.files.get("note2.md")!),
      "after cancel",
    );
  } finally {
    await stop();
  }
});
