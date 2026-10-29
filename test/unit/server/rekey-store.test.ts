import { openDb } from "../../../server/db.ts";
import {
  getCurrentHeadVersion,
  getHeadsAfter,
  getReplaySince,
  getVersionChain,
  insertVersion,
} from "../../../server/db.ts";
import { listTrash, trashHead } from "../../../server/trash-db.ts";
import { getBlob, putBlob } from "../../../server/blobs.ts";
import { handleListDeviceStatus, handleListVaults } from "../../../server/admin-vaults.ts";
import { handleCreateDevice, handleGetVaultInfo } from "../../../server/provisioning.ts";
import {
  cancelStaging,
  createStaging,
  insertStagingTrash,
  insertStagingVersion,
  recoverRekeyBlobs,
  replaceTrashRow,
  replaceVersionRow,
  switchToStaging,
} from "../../../server/rekey-store.ts";
import type { VersionRow } from "../../../server/db.ts";
import { b64encode, RENAME_NOTE } from "../../../core/protocol.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const H = (c: string) => c.repeat(64);

function createVault(db: Database): { vaultId: string; salt: Uint8Array } {
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );
  return { vaultId, salt };
}

function createDevice(db: Database, vaultId: string): { deviceId: string; token: string } {
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
  return { deviceId, token };
}

function stagingRow(over: Partial<VersionRow>): VersionRow {
  return {
    version: 1,
    parent: null,
    seq: 1,
    path_hash: H("b"),
    enc_metadata: new Uint8Array([9, 9]),
    chunk_hashes: JSON.stringify([H("c")]),
    deleted: 0,
    device_id: "dev",
    created_at: 123,
    compacted_range: null,
    path_ciphertext: null,
    rename_mark: 0,
    restored: 0,
    ...over,
  };
}

function adminReq(token: string): Request {
  return new Request("http://localhost/vaults", {
    headers: { authorization: `Bearer ${token}` },
  });
}

Deno.test({
  name: "rekey - migration 013 adds rekey_of column to vaults (fresh DB)",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare("PRAGMA table_info(vaults)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const col = cols.find((c) => c.name === "rekey_of");
      assertEquals(col !== undefined, true, "vaults must have a rekey_of column");
      assertEquals(col!.notnull, 0, "rekey_of must be nullable");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - migration 013 applies on an existing pre-013 DB",
  fn() {
    const dataDir = makeTempDataDir();
    const migDir = makeTempDataDir();
    try {
      const realDir = `${import.meta.dirname}/../../../db/migrations`;
      for (const entry of Deno.readDirSync(realDir)) {
        // Every migration from 013 on is a separate step, not part of the pre-013 schema.
        if (parseInt(entry.name.slice(0, 3), 10) >= 13) continue;
        Deno.copyFileSync(`${realDir}/${entry.name}`, `${migDir}/${entry.name}`);
      }
      const db1 = openDb(dataDir, migDir);
      const v1 = db1.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(v1.value, "12");
      db1.close();

      Deno.copyFileSync(`${realDir}/013_rekey_staging.sql`, `${migDir}/013_rekey_staging.sql`);
      const db2 = openDb(dataDir, migDir);
      const v2 = db2.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(v2.value, "13");
      const col = db2
        .prepare("PRAGMA table_info(vaults)")
        .all()
        .find((c) => (c as { name: string }).name === "rekey_of");
      assertEquals(col !== undefined, true, "rekey_of must exist after 013 on an old DB");
      db2.close();
    } finally {
      removeTempDir(dataDir);
      removeTempDir(migDir);
    }
  },
});

Deno.test({
  name: "rekey - createStaging creates a hidden vault row referencing V with copied salt",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId, salt } = createVault(db);
      const stagingId = createStaging(db, vaultId);

      const row = db.prepare(
        "SELECT name, salt, rekey_of FROM vaults WHERE id = ?",
      ).get(stagingId) as { name: string; salt: Uint8Array; rekey_of: string };
      assertEquals(row.rekey_of, vaultId);
      assertEquals(b64encode(row.salt), b64encode(salt));

      const vRow = db.prepare("SELECT rekey_of FROM vaults WHERE id = ?").get(vaultId) as {
        rekey_of: string | null;
      };
      assertEquals(vRow.rekey_of, null);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - createStaging refuses a second staging vault for V",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      createStaging(db, vaultId);
      assertThrows(() => createStaging(db, vaultId));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - createStaging refuses a vault that is itself staging",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      assertThrows(() => createStaging(db, stagingId));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - staging rows are invisible to V's heads, replay, trash, admin listing",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const vHash = H("a");
      const result = insertVersion(
        db,
        vaultId,
        vHash,
        0,
        new Uint8Array([1]),
        [H("d")],
        false,
        deviceId,
      );
      assert(!("conflict" in result));
      trashHead(db, vaultId, vHash, result.version, deviceId);

      const stagingId = createStaging(db, vaultId);
      insertStagingVersion(db, stagingId, stagingRow({ device_id: deviceId }));
      insertStagingTrash(
        db,
        stagingId,
        {
          path_hash: H("b"),
          head_json: JSON.stringify({
            version: 1,
            parent: null,
            chunk_hashes: [H("c")],
            enc_metadata: "eA==",
            deleted: 0,
          }),
          deleted_by_device: deviceId,
          trashed_at: 100,
        },
      );

      // V's reads are unchanged.
      const heads = [...getHeadsAfter(db, vaultId, 0)];
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, vHash);
      const replay = [...getReplaySince(db, vaultId, 0)];
      assertEquals(replay.length, 1);
      assertEquals(replay[0].path_hash, vHash);
      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 1);
      assertEquals(trash[0].path_hash, vHash);

      // Admin listing excludes the staging vault.
      const resp = handleListVaults(db, adminReq("admin-token"), "admin-token");
      const listed = (await resp.json()) as Array<{ id: string }>;
      assertEquals(listed.some((v) => v.id === stagingId), false);
      assertEquals(listed.some((v) => v.id === vaultId), true);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - insertStagingVersion carries rename_mark (#583)",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      const stagingId = createStaging(db, vaultId);
      insertStagingVersion(
        db,
        stagingId,
        stagingRow({ device_id: deviceId, rename_mark: RENAME_NOTE }),
      );
      const row = db.prepare(
        "SELECT rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      ).get(stagingId, H("b")) as { rename_mark: number };
      assertEquals(row.rename_mark, RENAME_NOTE);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - staging vault is unreachable: device creation 404, device token vault-mismatch",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { token } = createDevice(db, vaultId);
      const stagingId = createStaging(db, vaultId);

      // No device can be provisioned for a staging vault.
      const created = await handleCreateDevice(
        db,
        stagingId,
        new Request("http://localhost/vaults/x/devices", {
          method: "POST",
          headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
          body: JSON.stringify({ device_name: "d" }),
        }),
        "admin-token",
      );
      assertEquals(created.status, 404);

      // V's device token cannot be used against the staging vault (no device
      // row can reference it, and the vault pin rejects the mismatch).
      const status = handleListDeviceStatus(
        db,
        stagingId,
        new Request("http://localhost/vaults/x/devices/status", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      assertEquals(status.status, 403);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - switchToStaging moves rows and blobs, sets verifier and params, removes S",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const vHash = H("a");
      const result = insertVersion(
        db,
        vaultId,
        vHash,
        0,
        new Uint8Array([1]),
        [H("d")],
        false,
        deviceId,
      );
      assert(!("conflict" in result));
      trashHead(db, vaultId, vHash, result.version, deviceId);
      await putBlob(dataDir, vaultId, H("d"), new Uint8Array([1, 2, 3]));

      const stagingId = createStaging(db, vaultId);
      insertStagingVersion(
        db,
        stagingId,
        stagingRow({ device_id: deviceId, compacted_range: "1-3" }),
      );
      insertStagingTrash(
        db,
        stagingId,
        {
          path_hash: H("b"),
          head_json: JSON.stringify({
            version: 1,
            parent: null,
            chunk_hashes: [H("c")],
            enc_metadata: "eA==",
            deleted: 0,
          }),
          deleted_by_device: deviceId,
          trashed_at: 100,
        },
      );
      await putBlob(dataDir, stagingId, H("c"), new Uint8Array([4, 5, 6]));

      switchToStaging(db, dataDir, vaultId, stagingId, {
        verifier: "new-verifier",
        argon2_ops: 2,
        argon2_mem: 1 << 20,
        authHash: "h".repeat(64),
      });

      // auth_hash lands and rekey_mode clears inside the switch transaction (#556).
      const vrow = db.prepare("SELECT auth_hash, rekey_mode FROM vaults WHERE id = ?").get(
        vaultId,
      ) as {
        auth_hash: string | null;
        rekey_mode: string | null;
      };
      assertEquals(vrow.auth_hash, "h".repeat(64));
      assertEquals(vrow.rekey_mode, null);

      // compacted_range must survive the switch (#555 review).
      const chain = getVersionChain(db, vaultId, H("b"), 1);
      assertEquals(chain.length, 1);
      assertEquals(chain[0].compacted_range, "1-3");

      // Rows moved to V under the new path hashes.
      const heads = [...getHeadsAfter(db, vaultId, 0)];
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, H("b"));
      assertEquals(heads[0].enc_metadata, new Uint8Array([9, 9]));
      assertEquals(getCurrentHeadVersion(db, vaultId, vHash), null);
      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 1);
      assertEquals(trash[0].path_hash, H("b"));

      // Verifier + params set on V; S's vault row gone.
      const v = db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem FROM vaults WHERE id = ?",
      ).get(vaultId) as { verifier: string; argon2_ops: number; argon2_mem: number };
      assertEquals(v.verifier, "new-verifier");
      assertEquals(v.argon2_ops, 2);
      assertEquals(v.argon2_mem, 1 << 20);
      assertEquals(db.prepare("SELECT id FROM vaults WHERE id = ?").get(stagingId), undefined);

      // Blobs swapped: new blob readable under V, old blob gone, dirs clean.
      assertEquals(await getBlob(dataDir, vaultId, H("c")), new Uint8Array([4, 5, 6]));
      assertEquals(await getBlob(dataDir, vaultId, H("d")), null);
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${stagingId}`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));
      assertThrows(
        () => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`),
        "intent file must be deleted last",
      );

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - switchToStaging refuses a staging vault that does not pair with the target",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { vaultId: otherId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      const vHash = H("a");
      insertVersion(db, vaultId, vHash, 0, new Uint8Array([1]), [H("d")], false, deviceId);
      createStaging(db, vaultId);

      assertThrows(
        () =>
          switchToStaging(db, dataDir, vaultId, otherId, {
            verifier: "v",
            argon2_ops: 1,
            argon2_mem: 1 << 20,
            authHash: "h".repeat(64),
          }),
        Error,
        "does not pair",
      );
      // V untouched: rows and vault row intact, no intent written.
      assertEquals(getCurrentHeadVersion(db, vaultId, vHash), 1);
      assertEquals(
        db.prepare("SELECT id FROM vaults WHERE id = ?").get(otherId) !== undefined,
        true,
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - cancelStaging refuses a non-staging vault",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      const vHash = H("a");
      insertVersion(db, vaultId, vHash, 0, new Uint8Array([1]), [H("d")], false, deviceId);
      await putBlob(dataDir, vaultId, H("d"), new Uint8Array([1, 2, 3]));

      assertThrows(() => cancelStaging(db, dataDir, vaultId), Error, "not a staging vault");

      assertEquals(
        db.prepare("SELECT id FROM vaults WHERE id = ?").get(vaultId) !== undefined,
        true,
      );
      assertEquals(getCurrentHeadVersion(db, vaultId, vHash), 1);
      assertEquals(await getBlob(dataDir, vaultId, H("d")), new Uint8Array([1, 2, 3]));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - admin vault info 404s for a staging vault",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);

      const staging = handleGetVaultInfo(db, stagingId, adminReq("admin-token"), "admin-token");
      assertEquals(staging.status, 404);

      const real = handleGetVaultInfo(db, vaultId, adminReq("admin-token"), "admin-token");
      assertEquals(real.status, 200);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - cancelStaging leaves V byte-identical (rows and blob files)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const vHash = H("a");
      const result = insertVersion(
        db,
        vaultId,
        vHash,
        0,
        new Uint8Array([1]),
        [H("d")],
        false,
        deviceId,
      );
      assert(!("conflict" in result));
      trashHead(db, vaultId, vHash, result.version, deviceId);
      await putBlob(dataDir, vaultId, H("d"), new Uint8Array([1, 2, 3]));

      const snapshot = {
        versions: JSON.stringify(
          db.prepare("SELECT * FROM file_versions WHERE vault_id = ? ORDER BY path_hash, version")
            .all(vaultId),
        ),
        trash: JSON.stringify(
          db.prepare("SELECT * FROM trashed_heads WHERE vault_id = ?").all(vaultId),
        ),
        vault: JSON.stringify(db.prepare("SELECT * FROM vaults WHERE id = ?").get(vaultId)),
        blob: (await getBlob(dataDir, vaultId, H("d")))!.slice(),
      };

      const stagingId = createStaging(db, vaultId);
      insertStagingVersion(db, stagingId, stagingRow({ device_id: deviceId }));
      insertStagingTrash(
        db,
        stagingId,
        { path_hash: H("b"), head_json: "{}", deleted_by_device: deviceId, trashed_at: 100 },
      );
      await putBlob(dataDir, stagingId, H("c"), new Uint8Array([4, 5, 6]));

      cancelStaging(db, dataDir, stagingId);

      assertEquals(
        JSON.stringify(
          db.prepare("SELECT * FROM file_versions WHERE vault_id = ? ORDER BY path_hash, version")
            .all(vaultId),
        ),
        snapshot.versions,
      );
      assertEquals(
        JSON.stringify(db.prepare("SELECT * FROM trashed_heads WHERE vault_id = ?").all(vaultId)),
        snapshot.trash,
      );
      assertEquals(
        JSON.stringify(db.prepare("SELECT * FROM vaults WHERE id = ?").get(vaultId)),
        snapshot.vault,
      );
      assertEquals(await getBlob(dataDir, vaultId, H("d")), snapshot.blob);
      assertEquals(db.prepare("SELECT id FROM vaults WHERE id = ?").get(stagingId), undefined);
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${stagingId}`));

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - replaceVersionRow rewrites a version row in place",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const oldHash = H("e");
      const result = insertVersion(
        db,
        vaultId,
        oldHash,
        0,
        new Uint8Array([1]),
        [H("d")],
        false,
        deviceId,
      );
      assert(!("conflict" in result));

      replaceVersionRow(
        db,
        vaultId,
        oldHash,
        stagingRow({
          version: result.version,
          path_hash: H("f"),
          enc_metadata: new Uint8Array([7]),
          chunk_hashes: JSON.stringify([H("d")]),
          device_id: deviceId,
        }),
      );

      assertEquals(getCurrentHeadVersion(db, vaultId, oldHash), null);
      const heads = [...getHeadsAfter(db, vaultId, 0)];
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, H("f"));
      assertEquals(heads[0].enc_metadata, new Uint8Array([7]));
      assertEquals(heads[0].version, 1);
      assertEquals(heads[0].seq, 1);

      assertThrows(() =>
        replaceVersionRow(db, vaultId, oldHash, stagingRow({ version: 1, device_id: deviceId }))
      );

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - replaceTrashRow rewrites a trash row in place",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);

      const oldHash = H("e");
      const result = insertVersion(
        db,
        vaultId,
        oldHash,
        0,
        new Uint8Array([1]),
        [H("d")],
        false,
        deviceId,
      );
      assert(!("conflict" in result));
      trashHead(db, vaultId, oldHash, result.version, deviceId);

      replaceTrashRow(db, vaultId, oldHash, {
        path_hash: H("h"),
        head_json: JSON.stringify({
          version: 1,
          parent: null,
          chunk_hashes: [H("d")],
          enc_metadata: "eA==",
          deleted: 0,
        }),
        deleted_by_device: deviceId,
        trashed_at: 200,
      });

      const trash = listTrash(db, vaultId);
      assertEquals(trash.length, 1);
      assertEquals(trash[0].path_hash, H("h"));
      assertEquals(trash[0].trashed_at, 200);
      assertEquals(
        db.prepare("SELECT * FROM trashed_heads WHERE path_hash = ?").get(oldHash),
        undefined,
      );

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

function writeIntent(dataDir: string, vaultId: string, stagingId: string): void {
  Deno.mkdirSync(`${dataDir}/blobs`, { recursive: true });
  Deno.writeTextFileSync(`${dataDir}/blobs/${vaultId}.rekey-switch`, stagingId);
}

async function blobFile(
  dataDir: string,
  vaultId: string,
  name: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(`${dataDir}/blobs/${vaultId}/${name.slice(0, 2)}`, { recursive: true });
  await Deno.writeTextFile(
    `${dataDir}/blobs/${vaultId}/${name.slice(0, 2)}/${name.slice(2)}`,
    content,
  );
}

Deno.test({
  name: "rekey - recoverRekeyBlobs removes leftover .old dir when the live dir is in place",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = crypto.randomUUID();
      await blobFile(dataDir, vaultId, "aa".padEnd(64, "a"), "live");
      await blobFile(dataDir, `${vaultId}.old`, "aa".padEnd(64, "a"), "old");

      recoverRekeyBlobs(db, dataDir);

      assertEquals(
        await Deno.readTextFile(`${dataDir}/blobs/${vaultId}/aa/${"a".repeat(62)}`),
        "live",
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));

      // An orphan .old with no live dir is left for manual cleanup.
      const orphan = crypto.randomUUID();
      await blobFile(dataDir, `${orphan}.old`, "aa".padEnd(64, "a"), "orphan");
      recoverRekeyBlobs(db, dataDir);
      assertEquals(
        await Deno.readTextFile(`${dataDir}/blobs/${orphan}.old/aa/${"a".repeat(62)}`),
        "orphan",
      );
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name:
    "rekey - recovery: intent written, transaction not committed → intent dropped, V and S untouched",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      await blobFile(dataDir, vaultId, H("a"), "old-blob");
      await blobFile(dataDir, stagingId, H("c"), "new-blob");
      writeIntent(dataDir, vaultId, stagingId);

      recoverRekeyBlobs(db, dataDir);

      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      assertEquals(
        db.prepare("SELECT id FROM vaults WHERE id = ?").get(stagingId) !== undefined,
        true,
        "staging row must survive",
      );
      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${vaultId}/${H("a").slice(0, 2)}/${H("a").slice(2)}`,
        ),
        "old-blob",
      );
      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${stagingId}/${H("c").slice(0, 2)}/${H("c").slice(2)}`,
        ),
        "new-blob",
      );
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - recovery: committed, no rename done (V + S present) → swap finished",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      await blobFile(dataDir, vaultId, H("a"), "old-blob");
      await blobFile(dataDir, stagingId, H("c"), "new-blob");
      writeIntent(dataDir, vaultId, stagingId);
      db.run("DELETE FROM vaults WHERE id = ?", stagingId); // simulate committed transaction

      recoverRekeyBlobs(db, dataDir);

      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${vaultId}/${H("c").slice(0, 2)}/${H("c").slice(2)}`,
        ),
        "new-blob",
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${stagingId}`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - recovery: crashed after first rename (V.old + S present) → swap finished",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      await blobFile(dataDir, `${vaultId}.old`, H("a"), "old-blob");
      await blobFile(dataDir, stagingId, H("c"), "new-blob");
      writeIntent(dataDir, vaultId, stagingId);
      db.run("DELETE FROM vaults WHERE id = ?", stagingId);

      recoverRekeyBlobs(db, dataDir);

      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${vaultId}/${H("c").slice(0, 2)}/${H("c").slice(2)}`,
        ),
        "new-blob",
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${stagingId}`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - recovery: stale V.old + V + S present → swap finishes without ENOTEMPTY",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      await blobFile(dataDir, `${vaultId}.old`, H("a"), "stale-old");
      await blobFile(dataDir, vaultId, H("a"), "old-blob");
      await blobFile(dataDir, stagingId, H("c"), "new-blob");
      writeIntent(dataDir, vaultId, stagingId);
      db.run("DELETE FROM vaults WHERE id = ?", stagingId);

      recoverRekeyBlobs(db, dataDir);

      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${vaultId}/${H("c").slice(0, 2)}/${H("c").slice(2)}`,
        ),
        "new-blob",
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${stagingId}`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - recovery: crashed after second rename (V.old + V present) → V.old removed",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const stagingId = createStaging(db, vaultId);
      await blobFile(dataDir, `${vaultId}.old`, H("a"), "old-blob");
      await blobFile(dataDir, vaultId, H("c"), "new-blob");
      writeIntent(dataDir, vaultId, stagingId);
      db.run("DELETE FROM vaults WHERE id = ?", stagingId);

      recoverRekeyBlobs(db, dataDir);

      assertEquals(
        await Deno.readTextFile(
          `${dataDir}/blobs/${vaultId}/${H("c").slice(0, 2)}/${H("c").slice(2)}`,
        ),
        "new-blob",
      );
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.old`));
      assertThrows(() => Deno.statSync(`${dataDir}/blobs/${vaultId}.rekey-switch`));
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});
