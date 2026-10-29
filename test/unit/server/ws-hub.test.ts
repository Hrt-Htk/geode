import { type Database, insertVersion, openDb } from "../../../server/db.ts";
import { VaultHub } from "../../../server/ws.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

interface FakeWs {
  sent: string[];
  ws: WebSocket;
}

function makeFakeWs(): FakeWs {
  const sent: string[] = [];
  return {
    sent,
    ws: {
      send: (data: string) => sent.push(data),
      close: () => {},
      bufferedAmount: 0,
    } as unknown as WebSocket,
  };
}

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
  name: "ws-hub - monotonic seq on insert",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "a".repeat(64);
      const enc = makeEncMeta("test.md");

      const r1 = insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      assert("version" in r1);
      assertEquals(r1.version, 1);
      assertEquals(r1.seq, 1);

      const r2 = insertVersion(db, "test-vault", pathHash, 1, enc, [], false, "dev1");
      assert("version" in r2);
      assertEquals(r2.version, 2);
      assertEquals(r2.seq, 2);

      const r3 = insertVersion(db, "test-vault", pathHash, 2, enc, [], false, "dev1");
      assert("version" in r3);
      assertEquals(r3.version, 3);
      assertEquals(r3.seq, 3);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-hub - stale parent rejection emits conflict",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      ensureVaultAndDevice(db, "test-vault", "dev2");

      const pathHash = "b".repeat(64);
      const enc = makeEncMeta("test.md");

      const r1 = insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      assert("version" in r1);
      assertEquals(r1.version, 1);

      const result = insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev2");

      assert("conflict" in result, "should be a conflict");
      const conflict = result as { conflict: true; currentHead: number };
      assertEquals(conflict.currentHead, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-hub - concurrent same-parent: first wins, second conflicts",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      ensureVaultAndDevice(db, "test-vault", "dev2");

      const pathHash = "c".repeat(64);
      const enc = makeEncMeta("test.md");

      const r1 = insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev1");
      const r2 = insertVersion(db, "test-vault", pathHash, 0, enc, [], false, "dev2");

      assert("conflict" in r2, "second commit should conflict");
      assert("version" in r1, "first commit should succeed");

      // Verify only one version was inserted
      const head = (db.prepare(
        "SELECT MAX(version) AS v FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      ).get("test-vault", pathHash) as { v: number | null }).v;
      assertEquals(head, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-hub - conflict on a vault with no commits returns conflict, not a TypeError",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      const pathHash = "f".repeat(64);
      const enc = makeEncMeta("test.md");

      // No commits yet (currentHead = 0); a non-zero parent must hit the
      // conflict path, which must not deref a missing seq_counters row.
      const result = insertVersion(db, "test-vault", pathHash, 3, enc, [], false, "dev1");
      assert("conflict" in result, "should return conflict, not throw");
      assertEquals(result.currentHead, 0);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-hub - stale connection close doesn't unregister a reconnected device",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");
      const hub = new VaultHub(db, dataDir, "test-vault", () => {});

      const conn1 = makeFakeWs();
      const conn2 = makeFakeWs();

      const oldConn = hub.register(conn1.ws, "dev1");
      hub.register(conn2.ws, "dev1");

      // The stale connection's runConnection finally runs for oldConn.
      hub.unregister(oldConn);

      // The live reconnected connection must still receive broadcasts.
      hub.broadcast({ type: "server_error", code: "test", message: "ping" });
      assertEquals(conn2.sent.length, 1);
      assertEquals(conn1.sent.length, 0);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "ws-hub - different paths can commit independently",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash1 = "d".repeat(64);
      const pathHash2 = "e".repeat(64);
      const enc = makeEncMeta("test.md");

      const r1 = insertVersion(db, "test-vault", pathHash1, 0, enc, [], false, "dev1");
      assert("version" in r1);
      assertEquals(r1.version, 1);
      assertEquals(r1.seq, 1);

      const r2 = insertVersion(db, "test-vault", pathHash2, 0, enc, [], false, "dev1");
      assert("version" in r2);
      assertEquals(r2.version, 1);
      assertEquals(r2.seq, 2);

      // Both paths at version 1
      const h1 = (db.prepare(
        "SELECT MAX(version) AS v FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      ).get("test-vault", pathHash1) as { v: number | null }).v;
      const h2 = (db.prepare(
        "SELECT MAX(version) AS v FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      ).get("test-vault", pathHash2) as { v: number | null }).v;
      assertEquals(h1, 1);
      assertEquals(h2, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});
