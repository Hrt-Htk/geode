import { openDb } from "../../../server/db.ts";
import { Database } from "@db/sqlite";
import { assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

Deno.test({
  name: "migrations - fresh DB applies all migrations and sets schema_version",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(row.value, "17");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - re-running on already-migrated DB is a no-op",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db1 = openDb(dataDir);
      db1.close();

      const db2 = openDb(dataDir);
      const row = db2.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(row.value, "17");
      db2.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #583: the column every pre-existing row needs a 0 in: a constant default keeps
// the ADD COLUMN O(1) and old rows read as ordinary versions.
Deno.test({
  name: "migrations - 015 adds rename_mark to file_versions defaulting to 0",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const col = (db.prepare("PRAGMA table_info(file_versions)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === "rename_mark");
      assertEquals(col !== undefined, true, "file_versions must have a rename_mark column");
      assertEquals(col!.notnull, 1, "rename_mark must not be nullable");
      assertEquals(col!.dflt_value, "0");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - WAL mode is active",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assertEquals(row.journal_mode, "wal");

      // Checkpoint WAL so files can be released on Windows
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - 007 adds compacted_range column to file_versions",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare(
        "PRAGMA table_info(file_versions)",
      ).all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assertEquals(names.includes("compacted_range"), true);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - 008 adds path_ciphertext column to file_versions",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare(
        "PRAGMA table_info(file_versions)",
      ).all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assertEquals(names.includes("path_ciphertext"), true);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - 009 adds argon2_ops and argon2_mem columns to vaults",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare(
        "PRAGMA table_info(vaults)",
      ).all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      assertEquals(names.includes("argon2_ops"), true);
      assertEquals(names.includes("argon2_mem"), true);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - a failing migration is rolled back, propagates, leaves no partial state",
  fn() {
    const dataDir = makeTempDataDir();
    const migDir = makeTempDataDir();
    try {
      Deno.writeTextFileSync(
        `${migDir}/001_good.sql`,
        `CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT INTO _meta(key,value) VALUES('schema_version','1');\n`,
      );
      Deno.writeTextFileSync(
        `${migDir}/002_bad.sql`,
        `CREATE TABLE partial_table (id INTEGER);\nSELECT * FROM missing_table;\n`,
      );

      let threw = false;
      try {
        openDb(dataDir, migDir);
      } catch {
        threw = true;
      }
      assertEquals(threw, true, "failed migration must propagate out of openDb");

      const db = new Database(`${dataDir}/geode.db`);
      const row = db.prepare(
        "SELECT value FROM _meta WHERE key = 'schema_version'",
      ).get() as { value: string };
      assertEquals(row.value, "1", "version stays at last good migration");
      const partial = db.prepare(
        "SELECT name FROM sqlite_master WHERE name = 'partial_table'",
      ).get();
      assertEquals(partial, undefined, "failed migration's DDL must roll back");
      db.close();
    } finally {
      removeTempDir(dataDir);
      removeTempDir(migDir);
    }
  },
});

Deno.test({
  name: "migrations - 012 adds nullable applied_seq column to devices",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare("PRAGMA table_info(devices)").all() as Array<{
        name: string;
        cid: number;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const col = cols.find((c) => c.name === "applied_seq");
      assertEquals(col !== undefined, true, "devices must have an applied_seq column");
      assertEquals(col!.notnull, 0, "applied_seq must be nullable (null = never reported)");
      assertEquals(col!.dflt_value, null, "applied_seq must have no default");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "migrations - 010 drops dead last_seen column from devices",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare("PRAGMA table_info(devices)").all() as Array<{
        name: string;
      }>;
      const names = cols.map((c) => c.name);
      assertEquals(names.includes("last_seen"), false);
      assertEquals(names.includes("last_seen_at"), true);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #687: a restore is credited to the real device that asked for it, so the row
// carries a mark: the apply rule skips a device's own version unless it is restored.
Deno.test({
  name: "migrations - 016 adds restored to file_versions not null defaulting to 0",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const col = (db.prepare("PRAGMA table_info(file_versions)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === "restored");
      assertEquals(col !== undefined, true, "file_versions must have a restored column");
      assertEquals(col!.notnull, 1, "restored must not be nullable");
      assertEquals(col!.dflt_value, "0", "an ordinary version reads as restored = 0");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #679: every vault needs a counter at all times (startup measures it), so the column
// is a constant default rather than a tri-state that every read has to interpret.
Deno.test({
  name: "migrations - 017 adds a stored_bytes counter to vaults defaulting to 0",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const col = (db.prepare("PRAGMA table_info(vaults)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === "stored_bytes");
      assertEquals(col !== undefined, true, "vaults must have a stored_bytes column");
      assertEquals(col!.notnull, 1, "stored_bytes must not be nullable");
      assertEquals(col!.dflt_value, "0", "a vault with no measurement yet reads as 0");
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

/** A migrations dir holding only the migrations below `max`: the schema an
 * existing deployment sits at before the next one applies. */
function migrationsBefore(max: number): string {
  const dir = `${makeTempDataDir()}/migrations`;
  Deno.mkdirSync(dir);
  const source = new URL("../../../db/migrations/", import.meta.url);
  for (const entry of Deno.readDirSync(source)) {
    if (!entry.isFile || parseInt(entry.name.slice(0, 3), 10) >= max) continue;
    Deno.copyFileSync(new URL(entry.name, source), `${dir}/${entry.name}`);
  }
  return dir;
}

// #687: prod carries a `geode-trash-restore` row migration 011 never flagged
// (is_restore stayed 0), the versions it authored, and: #330: possibly a real
// device a user renamed to that reserved name. The migration flags the pseudo row
// (it never handshook, so it has no plugin_version) and marks its versions.
Deno.test({
  name: "migrations - 016 flags the legacy restore pseudo device and the versions it authored",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const legacy = openDb(dataDir, migrationsBefore(16));
      legacy.run(
        "INSERT INTO vaults(id, name, salt, created_at) VALUES('v1','vault',?,1)",
        new Uint8Array(16),
      );
      legacy.run(
        "INSERT INTO devices(id, vault_id, name, token) VALUES('pseudo','v1','geode-trash-restore','tok-pseudo')",
      );
      legacy.run(
        "INSERT INTO devices(id, vault_id, name, token, plugin_version) VALUES('renamed','v1','geode-trash-restore','tok-real','1.2.3')",
      );
      for (const [version, deviceId] of [[1, "pseudo"], [2, "renamed"]] as const) {
        legacy.run(
          "INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at) VALUES('v1','aa',?,?,0,x'00','[]',0,?,1)",
          version,
          version,
          deviceId,
        );
      }
      legacy.close();

      const db = openDb(dataDir);
      const flagged = db.prepare(
        "SELECT is_restore FROM devices WHERE id = 'pseudo'",
      ).get() as { is_restore: number };
      assertEquals(flagged.is_restore, 1, "the legacy pseudo device is flagged");
      const renamed = db.prepare(
        "SELECT is_restore FROM devices WHERE id = 'renamed'",
      ).get() as { is_restore: number };
      assertEquals(renamed.is_restore, 0, "a real device that took the name is not flagged");

      const rows = db.prepare(
        "SELECT version, restored FROM file_versions ORDER BY version",
      ).all() as Array<{ version: number; restored: number }>;
      assertEquals(rows, [{ version: 1, restored: 1 }, { version: 2, restored: 0 }]);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});
