import { type Database, getHeadsAfter, insertVersion, openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

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
  name: "heads - GET /vaults/:id/heads returns latest non-deleted per path",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash1 = "a".repeat(64);
      const pathHash2 = "b".repeat(64);

      insertVersion(db, "test-vault", pathHash1, 0, makeEncMeta("a.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash1, 1, makeEncMeta("a.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash2, 0, makeEncMeta("b.md"), [], false, "dev1");

      const heads = [...getHeadsAfter(db, "test-vault", -1)];

      assertEquals(heads.length, 2);
      const head1 = heads.find((h) => h.path_hash === pathHash1);
      const head2 = heads.find((h) => h.path_hash === pathHash2);
      assert(head1);
      assert(head2);
      assertEquals(head1.version, 2);
      assertEquals(head2.version, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "heads - with after_seq returns heads with seq > K including tombstones",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "d".repeat(64);

      insertVersion(db, "test-vault", pathHash, 0, makeEncMeta("d.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 1, makeEncMeta("d.md"), [], true, "dev1");

      const heads = [...getHeadsAfter(db, "test-vault", 1)];
      assertEquals(heads.length, 1);
      assertEquals(heads[0].deleted, 1);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "heads - NDJSON output: one head per line, valid JSON",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash1 = "e".repeat(64);
      const pathHash2 = "f".repeat(64);

      insertVersion(db, "test-vault", pathHash1, 0, makeEncMeta("e.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash2, 0, makeEncMeta("f.md"), [], false, "dev1");

      const heads = [...getHeadsAfter(db, "test-vault", -1)];
      assertEquals(heads.length, 2);

      for (const head of heads) {
        const json = JSON.stringify(head);
        const parsed = JSON.parse(json);
        assert(typeof parsed.path_hash === "string");
        assert(typeof parsed.version === "number");
        assert(Array.isArray(parsed.chunk_hashes));
      }
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "heads - aborting mid-stream does not leak an unhandled rejection",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    const vaultId = "test-vault";
    const deviceId = "dev1";
    ensureVaultAndDevice(db, vaultId, deviceId);

    // Enough heads that the stream spans several writes after the first chunk is read.
    const count = 20_000;
    for (let i = 0; i < count; i++) {
      insertVersion(
        db,
        vaultId,
        i.toString(16).padStart(64, "0"),
        0,
        makeEncMeta(`f${i}.md`),
        [],
        false,
        deviceId,
      );
    }

    const handler = vaultRoutes(db, null, dataDir);
    const { port, shutdown, finished } = serveOnPortZero(handler);

    const rejected: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent): void => {
      rejected.push(e.reason);
      e.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onRejection);

    try {
      const controller = new AbortController();
      const res = await fetch(
        `http://localhost:${port}/vaults/${vaultId}/heads`,
        { headers: { Authorization: "Bearer test-token" }, signal: controller.signal },
      );
      assertEquals(res.status, 200);
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(rejected, [], "aborted /heads stream leaked an unhandled rejection");
    } finally {
      globalThis.removeEventListener("unhandledrejection", onRejection);
      await shutdown();
      await finished;
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "heads - one head per path",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      ensureVaultAndDevice(db, "test-vault", "dev1");

      const pathHash = "g".repeat(64);

      insertVersion(db, "test-vault", pathHash, 0, makeEncMeta("g.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 1, makeEncMeta("g.md"), [], false, "dev1");
      insertVersion(db, "test-vault", pathHash, 2, makeEncMeta("g.md"), [], false, "dev1");

      const heads = [...getHeadsAfter(db, "test-vault", -1)];
      assertEquals(heads.length, 1);
      assertEquals(heads[0].version, 3);
    } finally {
      removeTempDir(dataDir);
    }
  },
});
