// #582: Delete forever erases a file's history, not just its trash row. The client
// sends the names the file lived at (the History walk's chain) with the version
// ceiling of each; the server deletes exactly those generations, keeps every other
// file's markers, and refuses a ceiling that would reach a live head.

import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { insertVersion, openDb } from "../../../server/db.ts";
import { handlePurgeAll, handlePurgeExpired, handlePurgeOne } from "../../../server/trash.ts";
import { purgeExpiredTrash, trashHead } from "../../../server/trash-db.ts";
import { runCompaction, TRASH_RETENTION_DAYS } from "../../../server/compaction.ts";
import { b64encode, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const N = "n0".repeat(32); // a name (path hash): short values are fine, the server
const M = "m1".repeat(32); // never sees paths, only keyed hashes
const OTHER = "ot".repeat(32);

function createVault(db: Database): string {
  const vaultId = crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    crypto.getRandomValues(new Uint8Array(16)),
    Date.now(),
  );
  return vaultId;
}

function createDevice(db: Database, vaultId: string): { deviceId: string; token: string } {
  const deviceId = crypto.randomUUID();
  const token = b64encode(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return { deviceId, token };
}

type RowOpts = { mark?: number; deleted?: number; chunks?: string[] };

function addRow(
  db: Database,
  vaultId: string,
  deviceId: string,
  pathHash: string,
  version: number,
  opts: RowOpts = {},
): void {
  db.run(
    `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at, rename_mark)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    vaultId,
    pathHash,
    version,
    version,
    version - 1,
    new Uint8Array([1, 2, 3]),
    JSON.stringify(opts.chunks ?? [`c${pathHash.slice(0, 2)}-${version}`]),
    opts.deleted ?? 0,
    deviceId,
    Date.now(),
    opts.mark ?? 0,
  );
}

function versionsOf(db: Database, vaultId: string, pathHash: string): number[] {
  const rows = db.prepare(
    "SELECT version FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  ).all(vaultId, pathHash) as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

function trashRows(db: Database, vaultId: string): string[] {
  const rows = db.prepare("SELECT path_hash FROM trashed_heads WHERE vault_id = ?")
    .all(vaultId) as Array<{ path_hash: string }>;
  return rows.map((r) => r.path_hash);
}

function makeReq(path: string, method: string, body?: unknown, auth?: string): Request {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request(`http://localhost${path}`, init);
}

/** #677: a device token may purge only past the server's retention floor (inside it the
 * admin token is required), so these tests age the row past the floor first. */
function purgeable(
  db: Database,
  vaultId: string,
  pathHash: string,
  version: number,
  deviceId: string,
): void {
  trashHead(db, vaultId, pathHash, version, deviceId);
  db.run(
    "UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?",
    daysAgo(TRASH_RETENTION_DAYS + 1),
    vaultId,
    pathHash,
  );
}

const CHAIN = (path: string, upTo: number) => ({ path_hash: path, up_to: upTo });

// ── Delete forever ────────────────────────────────────────────────────

Deno.test({
  name: "trash-erase - delete forever erases the file's own generation and keeps the tombstone",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1 });
      addRow(db, vaultId, deviceId, OTHER, 1);
      purgeable(db, vaultId, N, 2, deviceId);

      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", undefined, token),
        null,
      );
      assertEquals(res.status, 200);

      assertEquals(
        versionsOf(db, vaultId, N),
        [3],
        "the tombstone stays: the name is still deleted",
      );
      assertEquals(versionsOf(db, vaultId, OTHER), [1], "another file is untouched");
      assertEquals(trashRows(db, vaultId), []);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - a reused name keeps the newer generation's versions",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      // file A: versions 1-2, renamed away (marker 3); file B created at the same name.
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { mark: RENAME_MARKER, deleted: 1 });
      addRow(db, vaultId, deviceId, N, 4);
      addRow(db, vaultId, deviceId, N, 5);
      addRow(db, vaultId, deviceId, N, 6, { deleted: 1 });
      purgeable(db, vaultId, N, 5, deviceId);

      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", undefined, token),
        null,
      );
      assertEquals(res.status, 200);

      assertEquals(
        versionsOf(db, vaultId, N),
        [1, 2, 3, 6],
        "B's saves go, A's chain and the tombstone stay",
      );
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - a rename chain erases both names up to their ceilings",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      // A lived at N (1, 2), renamed to M (marker 3 at N, note 1 at M), edited (2), deleted (3).
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, M, 1, { mark: RENAME_NOTE });
      addRow(db, vaultId, deviceId, M, 2);
      addRow(db, vaultId, deviceId, M, 3, { deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, OTHER, 1, { mark: RENAME_NOTE });
      purgeable(db, vaultId, M, 2, deviceId);

      const res = await handlePurgeOne(
        db,
        vaultId,
        M,
        makeReq(
          `/vaults/${vaultId}/trash/${M}`,
          "DELETE",
          { chain: [CHAIN(M, 2), CHAIN(N, 3)] },
          token,
        ),
        null,
      );
      assertEquals(res.status, 200);

      assertEquals(
        versionsOf(db, vaultId, M),
        [3],
        "the note and the save go, the tombstone stays",
      );
      assertEquals(
        versionsOf(db, vaultId, N),
        [3],
        "the earlier name keeps its own marker: erasing a name to zero rows breaks its version order",
      );
      assertEquals(versionsOf(db, vaultId, OTHER), [1], "another file's note is never deleted");
      assertEquals(trashRows(db, vaultId), []);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - refuses a trashed row whose name is live at its cap",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, N, 4); // the name is live again
      purgeable(db, vaultId, N, 4, deviceId); // and the row is stale: it caps at the live head

      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", undefined, token),
        null,
      );
      assertEquals(res.status, 409);
      assertEquals(versionsOf(db, vaultId, N), [1, 2, 3, 4], "a live head is never touched");
      assertEquals(trashRows(db, vaultId), [N], "and the row stays, so nothing is half-erased");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - refuses a path hash with no versions in this vault",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 2, deviceId);

      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(
          `/vaults/${vaultId}/trash/${N}`,
          "DELETE",
          { chain: [CHAIN("ff".repeat(32), 4)] },
          token,
        ),
        null,
      );
      assertEquals(res.status, 400);
      assertEquals(versionsOf(db, vaultId, N), [1, 2, 3], "nothing is erased");
      assertEquals(trashRows(db, vaultId), [N]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - an old client's body-less purge still erases the row's own generation",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 2, deviceId);

      const req = () => makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", undefined, token);
      const res = await handlePurgeOne(db, vaultId, N, req(), null);
      assertEquals(res.status, 200);
      assertEquals(versionsOf(db, vaultId, N), [3]);

      const again = await handlePurgeOne(db, vaultId, N, req(), null);
      assertEquals(again.status, 200, "an old client's retry is not an error");
      assertEquals(await again.json(), { purged: false }, "and says nothing was purged");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - the POST purge route takes the chain from the body",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, M, 1, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 2, deviceId);

      const handle = vaultRoutes(db, "admin", dataDir);
      const res = await handle(
        makeReq(`/vaults/${vaultId}/trash/${N}/purge`, "POST", { chain: [CHAIN(M, 1)] }, token),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { purged: true, versions: 2 });
      assertEquals(versionsOf(db, vaultId, N), [3]);
      assertEquals(versionsOf(db, vaultId, M), [1], "the earlier name's saves go, its head stays");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── Purge expired / purge all ─────────────────────────────────────────

function daysAgo(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 24 * 3600;
}

Deno.test({
  name:
    "trash-erase - purge expired erases a deleted file's own generation, never a renamed file's history",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      // A deleted file at N.
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { deleted: 1, chunks: [] });
      trashHead(db, vaultId, N, 2, deviceId);
      db.run(
        "UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?",
        daysAgo(90),
        vaultId,
        N,
      );
      // A renamed file: marker at M, note at OTHER: no trash row (a marker writes none).
      addRow(db, vaultId, deviceId, M, 1);
      addRow(db, vaultId, deviceId, M, 2, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, OTHER, 1, { mark: RENAME_NOTE });

      const purged = purgeExpiredTrash(db, 30 * 24 * 3600, vaultId);
      assertEquals(purged, 1);
      assertEquals(versionsOf(db, vaultId, N), [3], "the expired file's saves go");
      assertEquals(versionsOf(db, vaultId, M), [1, 2], "the renamed file's history stays");
      assertEquals(versionsOf(db, vaultId, OTHER), [1]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - purge expired keeps a trash row inside the retention window",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      trashHead(db, vaultId, N, 1, deviceId);

      assertEquals(purgeExpiredTrash(db, 30 * 24 * 3600, vaultId), 0);
      assertEquals(versionsOf(db, vaultId, N), [1, 2]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - purge all erases trashed generations and leaves renamed histories",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      trashHead(db, vaultId, N, 1, deviceId);
      addRow(db, vaultId, deviceId, M, 1);
      addRow(db, vaultId, deviceId, M, 2, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, OTHER, 1, { mark: RENAME_NOTE });

      const res = handlePurgeAll(
        db,
        vaultId,
        makeReq(`/vaults/${vaultId}/trash/purge-all`, "POST", undefined, "admin"),
        "admin",
      );
      assertEquals(res.status, 200);
      assertEquals(versionsOf(db, vaultId, N), [2]);
      assertEquals(
        versionsOf(db, vaultId, M),
        [1, 2],
        "a renamed file has no trash row, so it is untouched",
      );
      assertEquals(versionsOf(db, vaultId, OTHER), [1]);
      assertEquals(trashRows(db, vaultId), []);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - the purge-expired route erases the expired generation",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      trashHead(db, vaultId, N, 1, deviceId);
      db.run("UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ?", daysAgo(90), vaultId);

      const res = await handlePurgeExpired(
        db,
        vaultId,
        makeReq(`/vaults/${vaultId}/trash/purge-expired`, "POST", { retention_days: 30 }, token),
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { purged: 1 });
      assertEquals(versionsOf(db, vaultId, N), [2]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── GC ────────────────────────────────────────────────────────────────

function writeBlob(dataDir: string, vaultId: string, hash: string, ageMs: number): void {
  const dir = `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}`;
  Deno.mkdirSync(dir, { recursive: true });
  const file = `${dir}/${hash.slice(2)}`;
  Deno.writeTextFileSync(file, hash);
  Deno.utimeSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
}

function blobExists(dataDir: string, vaultId: string, hash: string): boolean {
  try {
    Deno.statSync(`${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name: "trash-erase - GC reclaims an erased file's blobs and keeps a live file's",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const gone = "11".repeat(32);
      const live = "22".repeat(32);
      addRow(db, vaultId, deviceId, N, 1, { chunks: [gone] });
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 1, deviceId);
      addRow(db, vaultId, deviceId, OTHER, 1, { chunks: [live] });
      const old = 48 * 3600 * 1000; // past the 24h GC grace
      writeBlob(dataDir, vaultId, gone, old);
      writeBlob(dataDir, vaultId, live, old);

      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", undefined, token),
        null,
      );
      assertEquals(res.status, 200);
      await runCompaction(db, dataDir, vaultId);

      assert(!blobExists(dataDir, vaultId, gone), "the erased version's blob is reclaimed");
      assert(blobExists(dataDir, vaultId, live), "a live file's blob stays");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── Version order and boundary caps (#636 review) ─────────────────────

Deno.test({
  name:
    "trash-erase - a name erased to its head keeps the head row so a create continues at head+1",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, M, 1, { mark: RENAME_NOTE });
      addRow(db, vaultId, deviceId, M, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, M, 1, deviceId);

      const res = await handlePurgeOne(
        db,
        vaultId,
        M,
        makeReq(`/vaults/${vaultId}/trash/${M}`, "DELETE", { chain: [CHAIN(N, 3)] }, token),
        null,
      );
      assertEquals(res.status, 200);

      assertEquals(versionsOf(db, vaultId, N), [3], "the marker is the name's head and it stays");
      // A device re-creating the old name sends the head it last saw as the parent, and
      // gets the next version: a zero-row name would make that commit a silent conflict.
      const next = insertVersion(db, vaultId, N, 3, new Uint8Array([9]), ["c9"], false, deviceId);
      assert(!("conflict" in next), "the re-created name must not conflict");
      assertEquals(next.version, 4);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - refuses a link cap that is not a rename marker or note",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, N, 4);
      addRow(db, vaultId, deviceId, M, 1);
      addRow(db, vaultId, deviceId, M, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, M, 1, deviceId);

      // #636: a content row is not a boundary: the cap could sit inside a live file.
      const res = await handlePurgeOne(
        db,
        vaultId,
        M,
        makeReq(`/vaults/${vaultId}/trash/${M}`, "DELETE", { chain: [CHAIN(N, 4)] }, token),
        null,
      );
      assertEquals(res.status, 400);
      assertEquals(versionsOf(db, vaultId, N), [1, 2, 3, 4], "nothing is erased");
      assertEquals(trashRows(db, vaultId), [M], "and the row stays, so the client can retry");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - drops a chain entry for the trashed name and de-duplicates repeated entries",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2);
      addRow(db, vaultId, deviceId, N, 3, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      addRow(db, vaultId, deviceId, M, 1);
      addRow(db, vaultId, deviceId, M, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, M, 1, deviceId);

      // The root entry (M, 1) is the server's to derive; pointing it at content must not
      // matter, and 40 repeats of one link must not blow the chain cap.
      const repeats = Array.from({ length: 40 }, () => CHAIN(N, 3));
      const res = await handlePurgeOne(
        db,
        vaultId,
        M,
        makeReq(
          `/vaults/${vaultId}/trash/${M}`,
          "DELETE",
          { chain: [CHAIN(M, 1), ...repeats] },
          token,
        ),
        null,
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { purged: true, versions: 3 });
      assertEquals(versionsOf(db, vaultId, N), [3]);
      assertEquals(versionsOf(db, vaultId, M), [2]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - refuses a chain longer than the walk can produce",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 1, deviceId);

      for (let i = 0; i < 33; i++) {
        addRow(db, vaultId, deviceId, `p${i}`, 1);
        addRow(db, vaultId, deviceId, `p${i}`, 2, { mark: RENAME_MARKER, deleted: 1, chunks: [] });
      }
      const chain = Array.from({ length: 33 }, (_, i) => CHAIN(`p${i}`, 2));
      const res = await handlePurgeOne(
        db,
        vaultId,
        N,
        makeReq(`/vaults/${vaultId}/trash/${N}`, "DELETE", { chain }, token),
        null,
      );
      assertEquals(res.status, 400);
      assertEquals(versionsOf(db, vaultId, N), [1, 2], "nothing is erased");
      assertEquals(trashRows(db, vaultId), [N]);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-erase - an unparseable body is refused instead of erased",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const vaultId = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      addRow(db, vaultId, deviceId, N, 1);
      addRow(db, vaultId, deviceId, N, 2, { deleted: 1, chunks: [] });
      purgeable(db, vaultId, N, 1, deviceId);

      const req = new Request(`http://localhost/vaults/${vaultId}/trash/${N}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{not json",
      });
      const res = await handlePurgeOne(db, vaultId, N, req, null);
      assertEquals(res.status, 400);
      assertEquals(versionsOf(db, vaultId, N), [1, 2], "nothing is erased");
      assertEquals(trashRows(db, vaultId), [N], "the row stays");
    } finally {
      removeTempDir(dataDir);
    }
  },
});
