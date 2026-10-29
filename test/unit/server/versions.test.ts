import {
  type Database,
  getReplaySince,
  getVersionChain,
  insertVersion,
  openDb,
} from "../../../server/db.ts";
import { assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function makeEncMeta(path: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ path, mtime: 0, size: 0, mime: "text/plain", plaintext_hash: "x" }),
  );
}

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

Deno.test({
  name: "versions - chain newest-first",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "h".repeat(64);
      const enc = makeEncMeta("h.md");

      insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 1, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 2, enc, [], false, "dev1");

      const chain = getVersionChain(db, "test-vault", pathHash, 3);
      assertEquals(chain.length, 3);
      assertEquals(chain[0].version, 3);
      assertEquals(chain[1].version, 2);
      assertEquals(chain[2].version, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - pagination via before works",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "i".repeat(64);
      const enc = makeEncMeta("i.md");

      insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 1, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 2, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 3, enc, [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 4, enc, [], false, "dev1");

      const chain = getVersionChain(db, "test-vault", pathHash, 5, 4);
      assertEquals(chain.length, 2);
      assertEquals(chain[0].version, 5);
      assertEquals(chain[1].version, 4);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - path_ciphertext stored and round-tripped on chain + replay",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "k".repeat(64);
      const enc = makeEncMeta("k.md");
      const pc = new Uint8Array([9, 8, 7, 6, 5]);
      // 8-arg call (no path_ciphertext) must still compile + work
      insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      // 9-arg call with ciphertext
      insertVersion(db, "test-vault", pathHash, 1, enc, [], false, "dev1", pc);

      const chain = getVersionChain(db, "test-vault", pathHash, 2);
      assertEquals(chain.length, 2);
      assertEquals(chain[0].path_ciphertext, pc);
      assertEquals(chain[1].path_ciphertext, null);

      const replay = [...getReplaySince(db, "test-vault", 1)];
      assertEquals(replay.length, 1);
      assertEquals(replay[0].path_ciphertext, pc);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - unknown pathHash returns empty array, not 404",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const chain = getVersionChain(db, "test-vault", "z".repeat(64), 100);
      assertEquals(chain.length, 0);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - up_to cursor pages a 150-row chain with no gaps or duplicates",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "p".repeat(64);
      const enc = makeEncMeta("p.md");
      for (let v = 0; v < 150; v++) {
        insertVersion(db, "test-vault", pathHash, v, enc, [], false, "dev1");
      }

      // The /versions client loop: newest page, then up_to = oldest - 1.
      const seen: number[] = [];
      let upTo = Infinity;
      for (;;) {
        const page = getVersionChain(db, "test-vault", pathHash, upTo);
        seen.push(...page.map((r) => r.version));
        if (page.length < 100) break;
        upTo = page[page.length - 1].version - 1;
      }

      assertEquals(seen.length, 150);
      assertEquals(seen[0], 150);
      assertEquals(seen.at(-1), 1);
      assertEquals(seen, Array.from({ length: 150 }, (_, i) => 150 - i));
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - limit 100 entries",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "j".repeat(64);
      const enc = makeEncMeta("j.md");

      for (let v = 0; v < 150; v++) {
        insertVersion(db, "test-vault", pathHash, v, enc, [], false, "dev1");
      }

      const chain = getVersionChain(db, "test-vault", pathHash, 150);
      assertEquals(chain.length, 100);
      assertEquals(chain[0].version, 150);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "versions - created_at comes back at millisecond precision (#464)",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "k".repeat(64);
      // A real Date.now()-scale stamp: the FFI driver reads INTEGER columns as
      // 32-bit, which hands the history modal a 1970 date unless the SELECT casts.
      const createdAt = 1_792_488_453_699;
      db.run(
        `INSERT INTO file_versions(vault_id, path_hash, version, seq, parent, enc_metadata, chunk_hashes, deleted, device_id, created_at, path_ciphertext)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "test-vault",
        pathHash,
        1,
        1,
        0,
        makeEncMeta("k.md"),
        "[]",
        0,
        "dev1",
        createdAt,
        null,
      );

      const chain = getVersionChain(db, "test-vault", pathHash, 1);
      assertEquals(chain[0].created_at, createdAt);
      // Replay hands the same rows to a reconnecting client: same 32-bit read.
      const replay = [...getReplaySince(db, "test-vault", 0)];
      assertEquals(replay[0].created_at, createdAt);
    } finally {
      removeTempDir(dataDir);
    }
  },
});
