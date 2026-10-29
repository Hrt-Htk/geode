import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { launchPair } from "../fixtures/pair";
import { assertNoLogErrors, runRekeyCopy } from "../helpers/rekey";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { chunkHashesFor } from "../helpers/interrupt";
import { computeVerifier } from "../helpers/verifier";
import { waitForContent, waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #561 scope 5 (desktop): history and trash survive a re-key: after a copy
// re-key, an OLDER version of a file (not the head) still decrypts to its
// pre-re-key content under the NEW keys (row + blobs re-encrypted), and a
// trashed file restores through the real trash API with its content intact.
// Chunk IDs are re-key-invariant (plaintext-hash addressed), so the rewritten
// v1 row is found by its unchanged chunk hashes.
const PASSPHRASE = "rekey-history-pass";
const NEW_PASSPHRASE = "rekey-history-new-pass";
const HISTORY = "notes/rekey-history.md";
const V1 = "# history\nversion one: must stay readable after the re-key\n";
const V2 = "# history\nversion two: the head after the re-key\n";
const TRASHED = "notes/rekey-trashed.md";
const TRASHED_CONTENT = "trashed before the re-key, restored after\n";

const DENO_BIN = process.env.DENO_BIN ?? "deno";
const execFileAsync = promisify(execFile);

type ServerRef = { dataDir: string; vaultId: string; salt: string };
type Row = {
  path_hash: string;
  enc_metadata: string;
  path_ciphertext: string | null;
  chunk_hashes: string[];
};

/** The re-keyed v1 version row, identified by its re-key-invariant chunk hashes. */
function findVersionRow(server: ServerRef, chunkHashes: string[]): Row {
  const db = new DatabaseSync(path.join(server.dataDir, "geode.db"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT path_hash, enc_metadata, path_ciphertext, chunk_hashes FROM file_versions WHERE vault_id = ?",
      )
      .all(server.vaultId) as {
        path_hash: string;
        enc_metadata: Uint8Array;
        path_ciphertext: Uint8Array | null;
        chunk_hashes: string;
      }[];
    const want = JSON.stringify(chunkHashes);
    const row = rows.find((r) => r.chunk_hashes === want);
    if (!row) throw new Error("re-keyed v1 version row not found by its chunk hashes");
    // enc_metadata / path_ciphertext are BLOBs in the DB (base64 on the wire).
    return {
      path_hash: row.path_hash,
      enc_metadata: Buffer.from(row.enc_metadata).toString("base64"),
      path_ciphertext: row.path_ciphertext
        ? Buffer.from(row.path_ciphertext).toString("base64")
        : null,
      chunk_hashes: JSON.parse(row.chunk_hashes),
    };
  } finally {
    db.close();
  }
}

/** The vault's single trashed head, re-keyed. */
function trashHeadRow(server: ServerRef): Row {
  const db = new DatabaseSync(path.join(server.dataDir, "geode.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT path_hash, head_json FROM trashed_heads WHERE vault_id = ?")
      .get(server.vaultId) as { path_hash: string; head_json: string } | undefined;
    if (!row) throw new Error("no trashed head on the server");
    const head = JSON.parse(row.head_json) as {
      enc_metadata: string;
      path_ciphertext: string | null;
      chunk_hashes: string[];
    };
    return { path_hash: row.path_hash, ...head };
  } finally {
    db.close();
  }
}

/** Decrypt a re-keyed row (metadata + blobs) with the NEW passphrase, using the
 * real core/ crypto: the row and its blobs must be readable under the new keys. */
async function decodeRow(server: ServerRef, row: Row, expected: string): Promise<{
  path: string;
  pathCiphertext: string | null;
  matches: boolean;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "geode-e2e-decryptrow-"));
  try {
    const itemsPath = path.join(dir, "row.json");
    await writeFile(
      itemsPath,
      JSON.stringify({
        dataDir: server.dataDir,
        vaultId: server.vaultId,
        passphrase: NEW_PASSPHRASE,
        saltB64: server.salt,
        ops: TEST_ARGON2_PARAMS.ops,
        mem: TEST_ARGON2_PARAMS.mem,
        pathHash: row.path_hash,
        encMetadata: row.enc_metadata,
        pathCiphertext: row.path_ciphertext,
        chunkHashes: row.chunk_hashes,
        expected,
      }),
    );
    const scriptPath = path.join(process.cwd(), "test", "e2e", "helpers", "decrypt-row.deno.ts");
    const { stdout, stderr } = await execFileAsync(DENO_BIN, [
      "run",
      "-A",
      "--no-check",
      scriptPath,
      itemsPath,
    ]);
    if (!stdout.trim()) throw new Error(`decrypt-row produced no output. stderr: ${stderr}`);
    return JSON.parse(stdout.trim()) as {
      path: string;
      pathCiphertext: string | null;
      matches: boolean;
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("issue561 rekey: history and trash readable after the switch", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await Promise.all([
      waitForUnlocked(pair.A),
      waitForUnlocked(pair.B),
      waitForStatusBar(pair.A.win, "Geode: synced", 60_000),
      waitForStatusBar(pair.B.win, "Geode: synced", 60_000),
    ]);

    // A builds a two-version history and trashes a file; both converge.
    await upsertVaultFile(pair.A, HISTORY, V1);
    await commitPath(pair.A, HISTORY);
    await upsertVaultFile(pair.A, HISTORY, V2);
    await commitPath(pair.A, HISTORY);
    await upsertVaultFile(pair.A, TRASHED, TRASHED_CONTENT);
    await commitPath(pair.A, TRASHED);
    await pair.A.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(TRASHED)});
      if (!file) throw new Error("expected file to trash: ${TRASHED}");
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(pair.A, TRASHED, "delete");
    expect(await waitForConvergence(pair.A, pair.B, HISTORY, 60_000)).toBe(V2);
    expect(await waitForConvergence(pair.A, pair.B, TRASHED, 60_000)).toBeNull();

    // The fixture bypasses the join flow (which stores the passphrase verifier
    // in settings), so B has none and would treat the re-key as "ok". Store a
    // real verifier so B detects the passphrase change, as a joined device would.
    const verifier = await computeVerifier(PASSPHRASE, pair.server.salt, TEST_ARGON2_PARAMS);
    await pair.B.eval(`
      app.plugins.plugins.geode.settings.verifier = ${JSON.stringify(verifier)};
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    // Copy re-key to completion.
    await runRekeyCopy(pair.A, PASSPHRASE, NEW_PASSPHRASE);
    await waitForStatusBar(pair.A.win, "Geode: synced", 120_000);

    // B re-prompts: it reaches the locked "passphrase changed elsewhere" state.
    await expect
      .poll(
        () =>
          pair.B.eval<boolean>(
            "app.plugins.plugins.geode.rekeyElsewhere === true && !app.plugins.plugins.geode.isUnlockedCheck()",
          ),
        { timeout: 90_000 },
      )
      .toBe(true);

    /* ---- History: the v1 row decrypts under the NEW keys ---- */
    const expected = await chunkHashesFor([{ path: HISTORY, content: V1 }]);
    const v1Row = findVersionRow(pair.server, expected[HISTORY]);
    const v1 = await decodeRow(pair.server, v1Row, V1);
    expect(v1.path, "v1 row metadata path under the new keys").toBe(HISTORY);
    expect(v1.pathCiphertext, "v1 row path ciphertext under the new keys").toBe(HISTORY);
    expect(v1.matches, "v1 blobs must decrypt to the pre-re-key content").toBe(true);

    /* ---- Trash: the trashed head decrypts, and restore brings the content back ---- */
    const head = trashHeadRow(pair.server);
    const trashed = await decodeRow(pair.server, head, TRASHED_CONTENT);
    expect(trashed.path, "trash head metadata path under the new keys").toBe(TRASHED);
    expect(trashed.matches, "trash head blobs must decrypt to the pre-re-key content").toBe(true);

    type TrashEntry = { path_hash: string; trashed_at: number; deleted_by_device: string };
    const trash = await pair.B.eval<TrashEntry[]>("await app.plugins.plugins.geode.trash.list()");
    expect(trash, "exactly one trashed file after the re-key").toHaveLength(1);
    // Restore is a server-side commit: it works while B is still locked.
    await pair.B.eval(
      `await app.plugins.plugins.geode.trash.restore(${JSON.stringify(trash[0].path_hash)})`,
    );
    // B unlocks with the NEW passphrase and applies the restored version.
    await pair.B.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(NEW_PASSPHRASE)})`,
    );
    await waitForUnlocked(pair.B, 60_000);
    await waitForContent(pair.A, pair.B, TRASHED, TRASHED_CONTENT, 60_000);

    /* ---- Log oracle ---- */
    await assertNoLogErrors(pair.A, "A LOG ERRORS");
  } finally {
    await pair.stop();
  }
});
