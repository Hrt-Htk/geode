import {
  deleteTrashedHead,
  getTrashedHead,
  listTrash,
  purgeExpiredTrash,
  trashHead,
} from "../../../server/trash-db.ts";
import { insertVersion, openDb } from "../../../server/db.ts";
import { b64encode } from "../../../core/protocol.ts";
import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function createVault(db: Database): { vaultId: string; salt: string } {
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(salt);
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );
  return { vaultId, salt: saltB64 };
}

function createDevice(db: Database, vaultId: string): string {
  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64encode(tokenBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return deviceId;
}

Deno.test({
  name: "trash - trashHead stores content version on delete",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const deviceId = createDevice(db, vaultId);

      const pathHash = "abc123def456";
      const encMetadata = new Uint8Array([1, 2, 3]);
      const chunkHashes = ["chunk1", "chunk2"];

      // Insert a content version (parent 0, deleted=false)
      const result = insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        encMetadata,
        chunkHashes,
        false,
        deviceId,
      );
      assert(!("conflict" in result));
      assertEquals(result.version, 1);

      // Trash the content version
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // Verify listTrash
      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 1);
      assertEquals(trash[0].path_hash, pathHash);
      assertEquals(trash[0].deleted_by_device, deviceId);
      assert(typeof trash[0].trashed_at === "number");

      // Verify getTrashedHead
      const trashed = getTrashedHead(db, vaultId, pathHash);
      assert(trashed !== null);
      const headJson = JSON.parse(trashed.head_json);
      assertEquals(headJson.chunk_hashes, chunkHashes);
      assertEquals(headJson.deleted, 0);
      assertEquals(headJson.version, 1);
      assertEquals(headJson.parent, 0);
      assert(typeof headJson.enc_metadata === "string");

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash - trash list row carries path_ciphertext for later decryption",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const deviceId = createDevice(db, vaultId);

      const pathHash = "path_ct_hash_123";
      const encMetadata = new Uint8Array([1, 2, 3]);
      const pc = new Uint8Array([10, 20, 30, 40]);

      const result = insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        encMetadata,
        ["c1"],
        false,
        deviceId,
        pc,
      );
      assert(!("conflict" in result));

      trashHead(db, vaultId, pathHash, result.version, deviceId);

      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 1);
      assertEquals(trash[0].path_hash, pathHash);
      // b64 of [10,20,30,40]
      assertEquals(trash[0].path_ciphertext, b64encode(new Uint8Array([10, 20, 30, 40])));
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash - trashHead with contentVersion 0 is a no-op",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const deviceId = createDevice(db, vaultId);

      const pathHash = "abc123def456";
      trashHead(db, vaultId, pathHash, 0, deviceId);

      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 0);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash - deleteTrashedHead removes entry and returns true/false",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const deviceId = createDevice(db, vaultId);

      const pathHash = "abc123def456";
      const encMetadata = new Uint8Array([1, 2, 3]);
      const chunkHashes = ["chunk1"];

      insertVersion(db, vaultId, pathHash, 0, encMetadata, chunkHashes, false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // First delete succeeds
      assertEquals(deleteTrashedHead(db, vaultId, pathHash), true);
      assertEquals(listTrash(db, vaultId).length, 0);

      // Second delete returns false
      assertEquals(deleteTrashedHead(db, vaultId, pathHash), false);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash - purgeExpiredTrash removes old rows but keeps recent ones",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const deviceId = createDevice(db, vaultId);

      const pathHashOld = "old123";
      const pathHashNew = "new456";
      const encMetadata = new Uint8Array([1, 2, 3]);
      const chunkHashes = ["chunk1"];

      // Insert content versions and trash them
      insertVersion(db, vaultId, pathHashOld, 0, encMetadata, chunkHashes, false, deviceId);
      trashHead(db, vaultId, pathHashOld, 1, deviceId);

      insertVersion(db, vaultId, pathHashNew, 0, encMetadata, chunkHashes, false, deviceId);
      trashHead(db, vaultId, pathHashNew, 1, deviceId);

      // Age the old entry
      const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 24 * 3600; // 60 days ago
      db.prepare(
        `UPDATE trashed_heads SET trashed_at = ? WHERE path_hash = ?`,
      ).run(oldTimestamp, pathHashOld);

      assertEquals(listTrash(db, vaultId).length, 2);

      // Purge with 30-day retention
      const purged = purgeExpiredTrash(db, 30 * 24 * 3600);
      assertEquals(purged, 1);

      // Only the new one remains
      const remaining = listTrash(db, vaultId);
      assertEquals(remaining.length, 1);
      assertEquals(remaining[0].path_hash, pathHashNew);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash - global purge skips re-keying vaults and staging vaults (#556)",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const old = Math.floor(Date.now() / 1000) - 40 * 24 * 3600; // past any retention

      // Normal vault: expired trash gets purged.
      const normal = createVault(db).vaultId;
      const dev1 = createDevice(db, normal);
      db.run(
        "INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at) VALUES(?,?,?,?,1,?,?,0,?,?)",
        normal,
        "a".repeat(64),
        1,
        1,
        new Uint8Array([1]),
        "[]",
        dev1,
        Date.now(),
      );
      db.run(
        "INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at) VALUES(?,?,?,?,?)",
        "a".repeat(64),
        normal,
        "{}",
        dev1,
        old,
      );

      // Re-keying vault: expired trash must survive.
      const rekeying = createVault(db).vaultId;
      const dev2 = createDevice(db, rekeying);
      db.run(
        "INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at) VALUES(?,?,?,?,1,?,?,0,?,?)",
        rekeying,
        "b".repeat(64),
        1,
        1,
        new Uint8Array([1]),
        "[]",
        dev2,
        Date.now(),
      );
      db.run(
        "INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at) VALUES(?,?,?,?,?)",
        "b".repeat(64),
        rekeying,
        "{}",
        dev2,
        old,
      );
      db.run("UPDATE vaults SET rekey_mode = 'copy' WHERE id = ?", rekeying);

      // Staging vault: expired trash must survive.
      const staging = createVault(db).vaultId;
      const dev3 = createDevice(db, staging);
      db.run(
        "INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at) VALUES(?,?,?,?,1,?,?,0,?,?)",
        staging,
        "c".repeat(64),
        1,
        1,
        new Uint8Array([1]),
        "[]",
        dev3,
        Date.now(),
      );
      db.run(
        "INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at) VALUES(?,?,?,?,?)",
        "c".repeat(64),
        staging,
        "{}",
        dev3,
        old,
      );
      db.run("UPDATE vaults SET rekey_of = ? WHERE id = ?", rekeying, staging);

      const purged = purgeExpiredTrash(db, 30 * 24 * 3600);
      assertEquals(purged, 1, "only the normal vault's expired trash is purged");
      assertEquals(
        db.prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?").get(rekeying) as {
          n: number;
        },
        { n: 1 },
      );
      assertEquals(
        db.prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?").get(staging) as {
          n: number;
        },
        { n: 1 },
      );
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});
