import { insertVersion, openDb } from "../../server/db.ts";
import { TRASH_RETENTION_DAYS } from "../../server/compaction.ts";
import { trashHead } from "../../server/trash-db.ts";
import { vaultRoutes } from "../../server/routes.ts";
import {
  listTrash,
  purgeExpiredTrash,
  purgeTrashOne,
  restoreTrashAll,
  restoreTrashOne,
} from "../../plugin/plumbing/trash-client.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../helpers/temp-dir.ts";
import { serveOnPortZero } from "../helpers/port.ts";

const ADMIN_TOKEN = "test-admin-token-trash";

// Seeds a vault + device + a content file_version (non-deleted) and returns ids.
function seedVaultDevice(
  db: ReturnType<typeof openDb>,
): { vaultId: string; deviceId: string; token: string } {
  const vaultId = "vault-" + crypto.randomUUID();
  const deviceId = "device-" + crypto.randomUUID();
  const token = "tok-" + crypto.randomUUID();
  const salt = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
  db.prepare(
    `INSERT INTO vaults(id, name, salt, created_at) VALUES(?, ?, ?, ?)`,
  ).run(vaultId, "test-vault", new Uint8Array(salt), Date.now());
  db.prepare(
    `INSERT INTO devices(id, vault_id, name, token) VALUES(?, ?, ?, ?)`,
  ).run(deviceId, vaultId, "test-device", token);
  return { vaultId, deviceId, token };
}

// Inserts a minimal content version (non-deleted) and returns the path_hash.
function seedContentVersion(
  db: ReturnType<typeof openDb>,
  vaultId: string,
  deviceId: string,
): string {
  const pathHash = "a".repeat(64);
  const encMetadata = new Uint8Array(32);
  const result = insertVersion(db, vaultId, pathHash, 0, encMetadata, [], false, deviceId);
  assert(!("conflict" in result), "expected clean insert");
  return pathHash;
}

/** #677: a device token may purge only past the server's retention floor. */
function backdatePastFloor(
  db: ReturnType<typeof openDb>,
  vaultId: string,
  pathHash: string,
): void {
  const cutoff = Math.floor(Date.now() / 1000) - (TRASH_RETENTION_DAYS + 1) * 24 * 3600;
  db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?`)
    .run(cutoff, vaultId, pathHash);
}

async function withServer(
  db: ReturnType<typeof openDb>,
  dataDir: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const handler = vaultRoutes(db, ADMIN_TOKEN, dataDir);
  const { port, shutdown, finished } = serveOnPortZero(handler);
  try {
    await fn(`http://localhost:${port}`);
  } finally {
    await shutdown();
    await finished;
  }
}

Deno.test({
  name: "trash-client - listTrash returns seeded entry",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = seedVaultDevice(db);
      const pathHash = seedContentVersion(db, vaultId, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      await withServer(db, dataDir, async (base) => {
        const { entries } = await listTrash(base, vaultId, token);
        assertEquals(entries.length, 1);
        assertEquals(entries[0].path_hash, pathHash);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-client - restoreTrashOne resolves; listTrash is empty afterwards",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = seedVaultDevice(db);
      const pathHash = seedContentVersion(db, vaultId, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      await withServer(db, dataDir, async (base) => {
        await restoreTrashOne(base, vaultId, token, pathHash);
        const { entries } = await listTrash(base, vaultId, token);
        assertEquals(entries.length, 0);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-client - restoreTrashAll returns { restored: 2, skipped: 0 } for two entries",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = seedVaultDevice(db);

      // seed first entry
      const pathHash1 = "b".repeat(64);
      const encMeta = new Uint8Array(32);
      const r1 = insertVersion(db, vaultId, pathHash1, 0, encMeta, [], false, deviceId);
      assert(!("conflict" in r1));
      trashHead(db, vaultId, pathHash1, 1, deviceId);

      // seed second entry
      const pathHash2 = "c".repeat(64);
      const r2 = insertVersion(db, vaultId, pathHash2, 0, encMeta, [], false, deviceId);
      assert(!("conflict" in r2));
      trashHead(db, vaultId, pathHash2, 1, deviceId);

      await withServer(db, dataDir, async (base) => {
        const result = await restoreTrashAll(base, vaultId, token);
        assertEquals(result.restored, 2);
        assertEquals(result.skipped, 0);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-client - purgeTrashOne removes the entry and the file's versions (#582)",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = seedVaultDevice(db);
      const pathHash = seedContentVersion(db, vaultId, deviceId);
      // A real delete writes the tombstone over the content, then trashes the content head.
      const tombstone = insertVersion(
        db,
        vaultId,
        pathHash,
        1,
        new Uint8Array(32),
        [],
        true,
        deviceId,
      );
      assert(!("conflict" in tombstone), "expected clean insert");
      trashHead(db, vaultId, pathHash, 1, deviceId);
      // #677: a device token purges only a row past the server's retention floor.
      backdatePastFloor(db, vaultId, pathHash);

      await withServer(db, dataDir, async (base) => {
        await purgeTrashOne(base, vaultId, token, pathHash, []);
        const { entries } = await listTrash(base, vaultId, token);
        assertEquals(entries.length, 0);
      });
      const rows = db.prepare(
        "SELECT version FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
      ).all(vaultId, pathHash) as Array<{ version: number }>;
      assertEquals(rows.map((row) => row.version), [2], "the saves are gone, the tombstone stays");
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-client - purgeExpiredTrash with retentionDays=0 only purges past the server floor",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = seedVaultDevice(db);
      const pathHash = seedContentVersion(db, vaultId, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // #532: a 0-day request must not purge fresh trash: the server clamps
      // to its own retention floor. Backdate past the floor and it purges.
      const fresh = Math.floor(Date.now() / 1000) - 100;
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?`)
        .run(fresh, vaultId, pathHash);

      await withServer(db, dataDir, async (base) => {
        const result = await purgeExpiredTrash(base, vaultId, token, 0);
        assertEquals(result.purged, 0, "fresh trash must survive a retention_days=0 request");

        const pastFloor = Math.floor(Date.now() / 1000) -
          (TRASH_RETENTION_DAYS + 5) * 24 * 3600;
        db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?`)
          .run(pastFloor, vaultId, pathHash);
        const result2 = await purgeExpiredTrash(base, vaultId, token, 0);
        assertEquals(result2.purged, 1, "entries past the server floor must be purged");
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
