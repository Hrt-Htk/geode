import { type Database, openDb } from "../../../server/db.ts";
import { lastRun, maybeScheduleCompaction, runCompaction } from "../../../server/compaction.ts";
import { assert, assertEquals } from "@std/assert";
import { RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const DAY = 24 * 3600 * 1000;

function ensureVaultAndDevice(db: Database, vaultId: string, deviceId: string): void {
  db.run(
    `INSERT OR IGNORE INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)`,
    vaultId,
    "test",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    `INSERT OR IGNORE INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)`,
    deviceId,
    vaultId,
    "test-device",
    "test-token",
  );
}

function insertRow(
  db: Database,
  vaultId: string,
  deviceId: string,
  pathHash: string,
  version: number,
  seq: number,
  created_at: number,
  chunkHashes: string[],
  renameMark = 0,
  deleted = 0,
): void {
  db.run(
    `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at, rename_mark)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    vaultId,
    pathHash,
    version,
    seq,
    version - 1,
    new Uint8Array([1, 2, 3]),
    JSON.stringify(chunkHashes),
    deleted,
    deviceId,
    created_at,
    renameMark,
  );
}

function writeBlob(dataDir: string, vaultId: string, hash: string, mtime: number): void {
  const dir = `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}`;
  Deno.mkdirSync(dir, { recursive: true });
  const p = `${dir}/${hash.slice(2)}`;
  Deno.writeFileSync(p, new TextEncoder().encode(hash));
  Deno.utimeSync(p, new Date(mtime), new Date(mtime));
}

function blobExists(dataDir: string, vaultId: string, hash: string): boolean {
  try {
    Deno.statSync(`${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`);
    return true;
  } catch {
    return false;
  }
}

function getRangeLabel(
  db: Database,
  vaultId: string,
  pathHash: string,
  version: number,
): string | null {
  const row = db.prepare(
    "SELECT compacted_range FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
  ).get(vaultId, pathHash, version) as { compacted_range: string | null } | undefined;
  return row ? row.compacted_range : null;
}

Deno.test({
  name: "compaction - folds old days, keeps recent/root/head, GC deletes unreferenced old blobs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "compact-vault";
      const deviceId = "dev1";
      const pathHash = "a".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);

      const NOW = Date.now();
      const OLD = NOW - 40 * DAY; // ~40 days ago -> old, one day
      const a = "a".repeat(64);
      const b = "b".repeat(64);
      const c = "c".repeat(64);
      const d = "d".repeat(64);
      const e = "e".repeat(64);
      const goneRef = "0".repeat(64); // referenced only by a DROPPED row
      const unrefOld = "f".repeat(64); // never referenced, old mtime -> deleted
      const unrefFresh = "g".repeat(64); // never referenced, fresh mtime -> kept
      const tmpFile = "deadbeef".padEnd(64, "1"); // in-flight .tmp- upload -> skipped

      // Old versions (same day): v1 root, v2-v4 folded, v5 day-last checkpoint
      insertRow(db, vaultId, deviceId, pathHash, 1, 1, OLD, [a]);
      insertRow(db, vaultId, deviceId, pathHash, 2, 2, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 3, 3, OLD, [goneRef]);
      insertRow(db, vaultId, deviceId, pathHash, 4, 4, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 5, 5, OLD, [b]);
      // Recent versions: v6-v8 all kept, v8 head
      insertRow(db, vaultId, deviceId, pathHash, 6, 6, NOW, [c]);
      insertRow(db, vaultId, deviceId, pathHash, 7, 7, NOW, [d]);
      insertRow(db, vaultId, deviceId, pathHash, 8, 8, NOW, [e]);

      // Blob files on disk
      writeBlob(dataDir, vaultId, a, OLD);
      writeBlob(dataDir, vaultId, b, OLD);
      writeBlob(dataDir, vaultId, c, OLD);
      writeBlob(dataDir, vaultId, d, OLD);
      writeBlob(dataDir, vaultId, e, OLD);
      writeBlob(dataDir, vaultId, goneRef, OLD); // only dropped v3 references this
      writeBlob(dataDir, vaultId, unrefOld, OLD);
      writeBlob(dataDir, vaultId, unrefFresh, NOW); // within 24h grace
      // in-flight tmp upload name (matches putBlob convention)
      const tmpDir = `${dataDir}/blobs/${vaultId}/${tmpFile.slice(0, 2)}`;
      Deno.mkdirSync(tmpDir, { recursive: true });
      const tmpP = `${tmpDir}/${tmpFile.slice(2)}.tmp-abcdef12`;
      Deno.writeFileSync(tmpP, new TextEncoder().encode("inflight"));
      Deno.utimeSync(tmpP, new Date(OLD), new Date(OLD));

      const result = await runCompaction(db, dataDir, vaultId);

      assertEquals(result.dropped, 3); // v2, v3, v4
      // dropped rows gone
      for (const v of [2, 3, 4]) {
        const row = db.prepare(
          "SELECT 1 FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
        ).get(vaultId, pathHash, v);
        assertEquals(row, undefined);
      }
      // kept rows survive
      for (const v of [1, 5, 6, 7, 8]) {
        const row = db.prepare(
          "SELECT 1 FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
        ).get(vaultId, pathHash, v);
        assert(row, `version ${v} should survive`);
      }
      // checkpoint v5 covers 2-5
      assertEquals(getRangeLabel(db, vaultId, pathHash, 5), "2-5");
      // non-checkpoints have no label
      assertEquals(getRangeLabel(db, vaultId, pathHash, 1), null);
      assertEquals(getRangeLabel(db, vaultId, pathHash, 8), null);

      // GC: deleted unreferenced old blobs (goneRef + unrefOld)
      assertEquals(result.gc, 2);
      assertEquals(blobExists(dataDir, vaultId, goneRef), false);
      assertEquals(blobExists(dataDir, vaultId, unrefOld), false);
      // retained blobs kept
      for (const h of [a, b, c, d, e]) {
        assertEquals(blobExists(dataDir, vaultId, h), true, `retained blob ${h.slice(0, 4)}`);
      }
      // fresh unreferenced kept (24h grace)
      assertEquals(blobExists(dataDir, vaultId, unrefFresh), true);
      // in-flight tmp file skipped
      let tmpGone = false;
      try {
        Deno.statSync(tmpP);
      } catch {
        tmpGone = true;
      }
      assertEquals(tmpGone, false);
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - keeps blobs referenced only by a trashed head (restore safety)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "trash-gc-vault";
      const deviceId = "dev4";
      const pathHash = "d".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);

      const NOW = Date.now();
      const OLD = NOW - 40 * DAY;
      const trashedRef = "h".repeat(64); // referenced only by the trashed head
      const live = "i".repeat(64); // referenced by the surviving day-checkpoint

      // Old versions, all one day: v1 root, v2-v4 folded, v5 day-checkpoint.
      // v3 is the content head that gets trashed when the file is deleted.
      insertRow(db, vaultId, deviceId, pathHash, 1, 1, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 2, 2, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 3, 3, OLD, [trashedRef]);
      insertRow(db, vaultId, deviceId, pathHash, 4, 4, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 5, 5, OLD, [live]);

      // Mirror trashHead's head_json shape: the trashed head stores v3's chunks.
      // Restoring it after compaction must find these blobs still on disk.
      const headJson = JSON.stringify({
        version: 3,
        parent: 2,
        chunk_hashes: [trashedRef],
        enc_metadata: "AAAA",
        path_ciphertext: null,
        deleted: 0,
      });
      db.run(
        `INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at)
         VALUES(?,?,?,?,?)`,
        pathHash,
        vaultId,
        headJson,
        deviceId,
        Math.floor(NOW / 1000),
      );

      writeBlob(dataDir, vaultId, trashedRef, OLD);
      writeBlob(dataDir, vaultId, live, OLD);

      const result = await runCompaction(db, dataDir, vaultId);

      assertEquals(result.dropped, 3); // v2, v3, v4 folded
      // v3's chunk is gone from file_versions but still referenced by the trashed
      // head: GC must keep it or restore breaks.
      assertEquals(
        blobExists(dataDir, vaultId, trashedRef),
        true,
        "blob referenced by a trashed head must survive compaction GC",
      );
      assertEquals(blobExists(dataDir, vaultId, live), true);
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - empty-chunks commit does not orphan the previous version's blobs",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "empty-chunks-vault";
      const deviceId = "dev6";
      const pathHash = "e".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);

      // #532 regression guard: v1 carries real chunks; v2 is an empty-chunks
      // commit (valid for empty files). Both are younger than the 30-day
      // compaction floor, so v1 must survive and its blob must stay retained
      // even though it is past the 24 h GC grace (mtime 25 h ago).
      const NOW = Date.now();
      const h25 = NOW - 25 * 3600 * 1000;
      const realChunk = "1".repeat(64);

      insertRow(db, vaultId, deviceId, pathHash, 1, 1, h25, [realChunk]);
      insertRow(db, vaultId, deviceId, pathHash, 2, 2, NOW, []);
      writeBlob(dataDir, vaultId, realChunk, h25); // past the 24 h GC grace

      const result = await runCompaction(db, dataDir, vaultId);

      // v1 is within the floor: not dropped, so its chunk is in the retained set.
      const v1 = db.prepare(
        "SELECT 1 FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
      ).get(vaultId, pathHash, 1);
      assert(v1, "v1 (younger than the 30-day floor) must survive compaction");
      assertEquals(
        blobExists(dataDir, vaultId, realChunk),
        true,
        "blob of a surviving version must not be GC'd by an empty-chunks successor",
      );
      assertEquals(result.gc, 0);
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - throttle prevents re-arming within the hour",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "throttle-vault";
      const deviceId = "dev2";
      const pathHash = "b".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);
      insertRow(db, vaultId, deviceId, pathHash, 1, 1, Date.now() - 40 * DAY, []);

      lastRun.clear();
      maybeScheduleCompaction(db, dataDir, vaultId);
      assert(lastRun.has(vaultId), "first call should arm");
      const t1 = lastRun.get(vaultId)!;
      assert(t1 >= Date.now() - 1000, "armed timestamp should be ~now");

      maybeScheduleCompaction(db, dataDir, vaultId);
      assertEquals(lastRun.get(vaultId), t1, "second call within hour must not re-arm");

      // Let the scheduled run complete and settle.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - periodic run also purges expired trash",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "trash-vault";
      const deviceId = "dev5";
      const pathHash = "a".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);
      // Old versions so a compaction actually runs.
      insertRow(db, vaultId, deviceId, pathHash, 1, 1, Date.now() - 40 * DAY, []);
      // Expired trashed head (> 30-day retention).
      db.run(
        `INSERT INTO trashed_heads(path_hash, vault_id, head_json, deleted_by_device, trashed_at)
         VALUES(?,?,?,?,?)`,
        "b".repeat(64),
        vaultId,
        JSON.stringify({ chunk_hashes: [] }),
        deviceId,
        Math.floor((Date.now() - 40 * DAY) / 1000),
      );

      await runCompaction(db, dataDir, vaultId);

      const row = db.prepare(
        "SELECT 1 FROM trashed_heads WHERE vault_id = ?",
      ).get(vaultId);
      assertEquals(row, undefined, "periodic compaction run must purge expired trash");
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - vault with only recent rows never arms",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "fresh-vault";
      const deviceId = "dev3";
      const pathHash = "c".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);
      insertRow(db, vaultId, deviceId, pathHash, 1, 1, Date.now(), []);

      lastRun.clear();
      maybeScheduleCompaction(db, dataDir, vaultId);
      assertEquals(lastRun.has(vaultId), false, "idle vault must not arm");
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});

Deno.test({
  name: "compaction - runCompaction aborts when rekey_mode is set",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      // Two old versions: a normal pass would fold away the older one.
      insertRow(db, "test-vault", "dev1", "a".repeat(64), 1, 1, Date.now() - 40 * DAY, [
        "c".repeat(64),
      ]);
      insertRow(db, "test-vault", "dev1", "a".repeat(64), 2, 2, Date.now() - 35 * DAY, [
        "c".repeat(64),
      ]);
      db.run("UPDATE vaults SET rekey_mode = 'replace' WHERE id = ?", "test-vault");
      const result = await runCompaction(db, dataDir, "test-vault");
      assertEquals(result, { dropped: 0, gc: 0 });
      const n = db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?").get(
        "test-vault",
      ) as { n: number };
      assertEquals(n.n, 2, "no rows may be compacted during a re-key session");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #583 §10: a reused name makes the marker and the note interior rows: the day
// plan would fold both away and the window would lose its boundary.
Deno.test({
  name: "compaction - rename marker and note rows are kept forever",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const vaultId = "rename-vault";
      const deviceId = "dev5";
      const pathHash = "e".repeat(64);
      ensureVaultAndDevice(db, vaultId, deviceId);

      const OLD = Date.now() - 60 * DAY; // every row is past the 30-day floor
      const noteRef = "k".repeat(64); // referenced only by the note (v6)

      // Generation 1 (v1-v4), the marker (v5), generation 2 (v6-v9).
      for (const v of [1, 2, 3, 4]) insertRow(db, vaultId, deviceId, pathHash, v, v, OLD, []);
      insertRow(db, vaultId, deviceId, pathHash, 5, 5, OLD, [], RENAME_MARKER, 1);
      insertRow(db, vaultId, deviceId, pathHash, 6, 6, OLD, [noteRef], RENAME_NOTE);
      for (const v of [7, 8, 9]) insertRow(db, vaultId, deviceId, pathHash, v, v, OLD, []);
      writeBlob(dataDir, vaultId, noteRef, OLD);

      const exists = (v: number) =>
        db.prepare(
          "SELECT 1 FROM file_versions WHERE vault_id = ? AND path_hash = ? AND version = ?",
        ).get(vaultId, pathHash, v) !== undefined;

      const result = await runCompaction(db, dataDir, vaultId);

      // root (1), head (9), day-last (9), marker (5), note (6).
      for (const v of [1, 5, 6, 9]) assert(exists(v), `version ${v} must survive`);
      for (const v of [2, 3, 4, 7, 8]) assertEquals(exists(v), false, `version ${v} must fold`);
      assertEquals(result.dropped, 5);
      // The note still keeps its blobs alive (GC is a reference scan).
      assertEquals(blobExists(dataDir, vaultId, noteRef), true);
    } finally {
      db.close();
      removeTempDir(dataDir);
      lastRun.clear();
    }
  },
});
