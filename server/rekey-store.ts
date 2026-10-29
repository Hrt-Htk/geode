// Re-key store (#555): server-internal primitives for passphrase/level re-keys.
// Copy mode stages a full re-encrypted vault under a hidden staging vault row
// (rekey_of), then switches in one transaction + blob-dir swap. Replace mode
// rewrites rows in place. No HTTP, auth, or protocol surface lives here,
// that is #556.
import type { Database } from "@db/sqlite";
import type { VersionRow } from "./db.ts";
import { b64decode } from "../core/protocol.ts";
import type { TrashedHeadRow } from "./trash-db.ts";
import { log } from "./log.ts";
import { measureVault, tryMeasureVault } from "./vault-budget.ts";

export interface RekeyParams {
  verifier: string;
  argon2_ops: number;
  argon2_mem: number;
  authHash: string;
}

export function createStaging(db: Database, vaultId: string): string {
  const v = db.prepare(
    "SELECT name, salt, rekey_of FROM vaults WHERE id = ?",
  ).get(vaultId) as { name: string; salt: Uint8Array; rekey_of: string | null } | null;
  if (!v) throw new Error(`vault not found: ${vaultId}`);
  if (v.rekey_of !== null) throw new Error("vault is itself a staging vault");
  const existing = db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(vaultId);
  if (existing) throw new Error("staging vault already exists");
  const stagingId = crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at, rekey_of) VALUES(?,?,?,?,?)",
    stagingId,
    v.name,
    v.salt,
    Date.now(),
    vaultId,
  );
  return stagingId;
}

// ON CONFLICT DO NOTHING: a client that re-posts a batch after a crash must
// not duplicate staging rows (PK is vault_id + path_hash + version).
export function insertStagingVersion(db: Database, stagingId: string, row: VersionRow): void {
  db.prepare(
    `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at, compacted_range, path_ciphertext, rename_mark, restored)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(vault_id, path_hash, version) DO NOTHING`,
  ).run(
    stagingId,
    row.path_hash,
    row.version,
    row.seq,
    row.parent,
    row.enc_metadata,
    row.chunk_hashes,
    row.deleted,
    row.device_id,
    row.created_at,
    row.compacted_range,
    row.path_ciphertext,
    row.rename_mark,
    row.restored,
  );
}

// Wire shape of a version row: enc_metadata / path_ciphertext travel base64, and
// a field missing from the list is silently stripped by the rewrite (#583).
export interface WireVersionRow {
  version: number;
  parent: number | null;
  seq: number;
  path_hash: string;
  enc_metadata: string;
  chunk_hashes: string;
  deleted: number;
  device_id: string;
  created_at: number;
  compacted_range: string | null;
  path_ciphertext: string | null;
  rename_mark?: number;
  /** #687: a re-key that drops it loses the restore label on those versions. */
  restored?: number;
}

export function decodeVersionRow(r: WireVersionRow): VersionRow {
  return {
    version: r.version,
    parent: r.parent,
    seq: r.seq,
    path_hash: r.path_hash,
    enc_metadata: b64decode(r.enc_metadata),
    chunk_hashes: r.chunk_hashes,
    deleted: r.deleted,
    device_id: r.device_id,
    created_at: r.created_at,
    compacted_range: r.compacted_range,
    path_ciphertext: r.path_ciphertext ? b64decode(r.path_ciphertext) : null,
    rename_mark: r.rename_mark ?? 0,
    restored: r.restored ?? 0,
  };
}

export function insertStagingTrash(
  db: Database,
  stagingId: string,
  row: Omit<TrashedHeadRow, "vault_id">,
): void {
  db.prepare(
    "INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at) VALUES(?,?,?,?,?) ON CONFLICT(path_hash) DO NOTHING",
  ).run(row.path_hash, stagingId, row.head_json, row.deleted_by_device, row.trashed_at);
}

// Durable switch marker: written (fsync + rename) BEFORE the switch
// transaction so a crash at any point is recoverable on startup.
function writeIntent(dataDir: string, vaultId: string, stagingId: string): void {
  const blobsDir = `${dataDir}/blobs`;
  Deno.mkdirSync(blobsDir, { recursive: true });
  const tmp = `${blobsDir}/${vaultId}.rekey-switch.tmp-${crypto.randomUUID().slice(0, 8)}`;
  Deno.writeTextFileSync(tmp, stagingId);
  const fd = Deno.openSync(tmp, { write: true });
  fd.sync();
  fd.close();
  Deno.renameSync(tmp, `${blobsDir}/${vaultId}.rekey-switch`);
}

export function switchToStaging(
  db: Database,
  dataDir: string,
  vaultId: string,
  stagingId: string,
  params: RekeyParams,
): void {
  const s = db.prepare("SELECT rekey_of FROM vaults WHERE id = ?").get(stagingId) as {
    rekey_of: string | null;
  } | null;
  if (!s || s.rekey_of !== vaultId) throw new Error("staging vault does not pair with target");
  writeIntent(dataDir, vaultId, stagingId);
  db.transaction(() => {
    db.run("DELETE FROM file_versions WHERE vault_id = ?", vaultId);
    db.run("DELETE FROM trashed_heads WHERE vault_id = ?", vaultId);
    db.run("UPDATE file_versions SET vault_id = ? WHERE vault_id = ?", vaultId, stagingId);
    db.run("UPDATE trashed_heads SET vault_id = ? WHERE vault_id = ?", vaultId, stagingId);
    // Verifier + params + auth hash + mode clear LAST (Rule 7): until this
    // commit, V is fully intact, and a crash inside it leaves no stuck mode.
    db.run(
      "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ?, auth_hash = ?, rekey_mode = NULL WHERE id = ?",
      params.verifier,
      params.argon2_ops,
      params.argon2_mem,
      params.authHash,
      vaultId,
    );
    db.run("DELETE FROM vaults WHERE id = ?", stagingId);
  })();
  finishBlobSwap(dataDir, vaultId, stagingId);
  // #679: the counter described the tree the swap just replaced. #680: the switch has
  // committed, so a failed walk is logged, not thrown at the caller as a failure.
  tryMeasureVault(db, dataDir, vaultId);
  Deno.removeSync(`${dataDir}/blobs/${vaultId}.rekey-switch`); // intent deleted last
}

function dirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

// blobs/V → blobs/V.old, blobs/S → blobs/V, remove blobs/V.old. Idempotent over
// every partial state (V+S, V.old+S, V.old+V, only V) so startup recovery can
// re-run it after a crash; a missing S dir means the staging had no blobs.
function finishBlobSwap(dataDir: string, vaultId: string, stagingId: string): void {
  const vDir = `${dataDir}/blobs/${vaultId}`;
  const sDir = `${dataDir}/blobs/${stagingId}`;
  const oldDir = `${dataDir}/blobs/${vaultId}.old`;
  if (dirExists(sDir)) {
    // A stale V.old from a prior crashed rekey would make the rename below
    // fail with ENOTEMPTY and brick the vault on every recovery.
    if (dirExists(oldDir)) Deno.removeSync(oldDir, { recursive: true });
    if (dirExists(vDir)) Deno.renameSync(vDir, oldDir);
    Deno.renameSync(sDir, vDir);
    if (dirExists(oldDir)) Deno.removeSync(oldDir, { recursive: true });
  } else if (dirExists(oldDir)) {
    Deno.removeSync(oldDir, { recursive: true });
  }
}

// Startup recovery for an interrupted switch (#555). The intent file
// blobs/<V>.rekey-switch (containing S) is the durable marker: if S's vault row
// still exists the transaction never committed, so V is untouched and the
// intent is simply dropped; if S's row is gone the switch committed and the
// blob swap is finished idempotently. Leftover .old dirs without a live dir
// cannot be attributed to a vault from the filesystem alone: leave them and
// log for manual cleanup.
export function recoverRekeyBlobs(db: Database, dataDir: string): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(`${dataDir}/blobs`)];
  } catch {
    return; // no blobs dir yet
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".rekey-switch")) {
      recoverSwitchIntent(db, dataDir, entry.name.slice(0, -".rekey-switch".length));
    } else if (entry.name.endsWith(".old")) {
      const oldPath = `${dataDir}/blobs/${entry.name}`;
      // Re-check: an earlier intent recovery in this pass may have removed it.
      if (!dirExists(oldPath)) continue;
      const live = `${dataDir}/blobs/${entry.name.slice(0, -4)}`;
      if (!dirExists(live)) {
        log.warn("rekey recovery: orphan .old blob dir left for manual cleanup", {
          dir: entry.name,
        });
        continue;
      }
      log.info("rekey recovery: removing leftover .old blob dir", { dir: entry.name });
      Deno.removeSync(oldPath, { recursive: true });
    }
  }
}

function recoverSwitchIntent(db: Database, dataDir: string, vaultId: string): void {
  const intentPath = `${dataDir}/blobs/${vaultId}.rekey-switch`;
  const stagingId = Deno.readTextFileSync(intentPath).trim();
  const staging = db.prepare("SELECT id FROM vaults WHERE id = ?").get(stagingId);
  if (staging) {
    log.info("rekey recovery: switch not committed, dropping intent", {
      vault_id: vaultId,
      staging_id: stagingId,
    });
  } else {
    finishBlobSwap(dataDir, vaultId, stagingId);
    measureVault(db, dataDir, vaultId);
    log.info("rekey recovery: finished interrupted blob swap", {
      vault_id: vaultId,
      staging_id: stagingId,
    });
  }
  Deno.removeSync(intentPath);
}

export function cancelStaging(db: Database, dataDir: string, stagingId: string): void {
  const s = db.prepare("SELECT rekey_of FROM vaults WHERE id = ?").get(stagingId) as {
    rekey_of: string | null;
  } | null;
  if (!s || s.rekey_of === null) throw new Error("not a staging vault");
  // trashed_heads has no FK to vaults, so it needs its own delete;
  // file_versions cascades from the vault row.
  db.run("DELETE FROM trashed_heads WHERE vault_id = ?", stagingId);
  db.run("DELETE FROM vaults WHERE id = ?", stagingId);
  try {
    Deno.removeSync(`${dataDir}/blobs/${stagingId}`, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

export function replaceVersionRow(
  db: Database,
  vaultId: string,
  oldPathHash: string,
  row: VersionRow,
): void {
  const changed = db.prepare(
    `UPDATE file_versions
     SET path_hash = ?, enc_metadata = ?, chunk_hashes = ?, path_ciphertext = ?, rename_mark = ?
     WHERE vault_id = ? AND path_hash = ? AND version = ?`,
  ).run(
    row.path_hash,
    row.enc_metadata,
    row.chunk_hashes,
    row.path_ciphertext,
    row.rename_mark,
    vaultId,
    oldPathHash,
    row.version,
  );
  if (changed === 0) {
    // Crash-resume (#556): the batch already landed: the old row is gone and
    // the rewritten row exists. Skip instead of failing the re-post.
    const exists = db.prepare(
      "SELECT 1 FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
    ).get(vaultId, row.path_hash, row.version);
    if (!exists) throw new Error(`version row not found: ${oldPathHash}@${row.version}`);
  }
}

export function replaceTrashRow(
  db: Database,
  vaultId: string,
  oldPathHash: string,
  row: Omit<TrashedHeadRow, "vault_id">,
): void {
  const changed = db.prepare(
    "UPDATE trashed_heads SET path_hash = ?, head_json = ?, deleted_by_device = ?, trashed_at = ? WHERE vault_id = ? AND path_hash = ?",
  ).run(
    row.path_hash,
    row.head_json,
    row.deleted_by_device,
    row.trashed_at,
    vaultId,
    oldPathHash,
  );
  if (changed === 0) {
    const exists = db.prepare(
      "SELECT 1 FROM trashed_heads WHERE vault_id = ? AND path_hash = ?",
    ).get(vaultId, row.path_hash);
    if (!exists) throw new Error(`trash row not found: ${oldPathHash}`);
  }
}
