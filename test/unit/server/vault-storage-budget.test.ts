// #679: the per-vault storage budget. Blob POSTs, re-key blob PUTs and commits are
// refused once a vault is past it, and the counter they read stays honest across writes,
// dedup hits, GC, compaction and a copy-mode re-key. The counter counts stored bytes:
// blob files plus the payload of the version and trash rows.
import { blobExists, putBlob, vaultBlobBytes } from "../../../server/blobs.ts";
import { blobRoutes } from "../../../server/blob-routes.ts";
import { type Database, getCurrentHeadVersion, insertVersion, openDb } from "../../../server/db.ts";
import { VaultHub } from "../../../server/ws.ts";
import { addVaultBytes, measureVault, vaultBytes } from "../../../server/vault-budget.ts";
import { createStaging, switchToStaging } from "../../../server/rekey-store.ts";
import { runCompaction } from "../../../server/compaction.ts";
import { trashHead } from "../../../server/trash-db.ts";
import { handleRestoreAll, handleRestoreOne } from "../../../server/trash.ts";
import { PROTOCOL_VERSION, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assert, assertEquals } from "@std/assert";
import { makeFakeSocket } from "../../helpers/fake-socket.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const DAY = 24 * 3600 * 1000;

function setup(db: Database): { vaultId: string; deviceId: string; token: string } {
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "tok-" + crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "budget-vault",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return { vaultId, deviceId, token };
}

// The cap is read per call so a test can move it; the default (20 GiB) is far past
// anything a test writes.
async function withBudget(bytes: number, fn: () => Promise<void>): Promise<void> {
  Deno.env.set("GEODE_VAULT_MAX_BYTES", String(bytes));
  try {
    await fn();
  } finally {
    Deno.env.delete("GEODE_VAULT_MAX_BYTES");
  }
}

function postBlobReq(hash: string, body: Uint8Array, token: string): Request {
  return new Request(`http://localhost/blobs/${hash}`, {
    method: "POST",
    body,
    headers: { Authorization: `Bearer ${token}` },
  });
}

function connection(db: Database, dataDir: string, vaultId: string, deviceId: string) {
  const hub = new VaultHub(db, dataDir, vaultId, () => {});
  const fake = makeFakeSocket();
  const done = hub.handleConnection(fake.ws, deviceId);
  fake.receive(JSON.stringify({
    type: "client_hello",
    protocol_version: PROTOCOL_VERSION,
    device_id: deviceId,
    last_seen_seq: 0,
    plugin_version: SERVER_VERSION,
  }));
  return { fake, done };
}

function commitMsg(
  pathHash: string,
  opts: { deleted?: boolean; parent?: number; renameMark?: number; encMetadata?: string } = {},
): string {
  return JSON.stringify({
    type: "client_commit",
    vault_id: "vault",
    path_hash: pathHash,
    parent_version: opts.parent ?? 0,
    enc_metadata: opts.encMetadata ?? "aGk=",
    chunk_hashes: [],
    deleted: opts.deleted ?? false,
    rename_mark: opts.renameMark,
  });
}

function restoreReq(vaultId: string, pathHash: string, token: string): Request {
  return new Request(`http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function restoreAllReq(vaultId: string, token: string): Request {
  return new Request(`http://localhost/vaults/${vaultId}/trash/restore-all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

type Msg = { type: string; code?: string; version?: number };

function messages(sent: string[]): Msg[] {
  return sent.map((s) => JSON.parse(s) as Msg);
}

function storedBytes(db: Database, vaultId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { n: number }).n;
}

Deno.test({
  name: "vault-storage - a blob POST past the budget is refused with 507 and stores nothing",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, token } = setup(db);
      const handler = blobRoutes(dataDir, db);
      await withBudget(1000, async () => {
        const first = await handler(postBlobReq("a".repeat(64), new Uint8Array(1000), token));
        assertEquals(first.status, 200);
        await first.body?.cancel();
        assertEquals(vaultBytes(db, vaultId), 1000);

        const second = await handler(postBlobReq("b".repeat(64), new Uint8Array(10), token));
        assertEquals(second.status, 507);
        await second.body?.cancel();
        assertEquals(await blobExists(dataDir, vaultId, "b".repeat(64)), false);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a blob POST under the budget is stored and counted",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, token } = setup(db);
      const handler = blobRoutes(dataDir, db);
      const first = await handler(postBlobReq("a".repeat(64), new Uint8Array(600), token));
      assertEquals(first.status, 200);
      await first.body?.cancel();
      // A dedup hit (the client lost its HEAD state) adds nothing to the count.
      const again = await handler(postBlobReq("a".repeat(64), new Uint8Array(600), token));
      assertEquals(again.status, 200);
      await again.body?.cancel();
      const other = await handler(postBlobReq("b".repeat(64), new Uint8Array(400), token));
      assertEquals(other.status, 200);
      await other.body?.cancel();
      assertEquals(vaultBytes(db, vaultId), 1000);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - concurrent POSTs of one new chunk count its bytes once",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, token } = setup(db);
      const handler = blobRoutes(dataDir, db);
      const hash = "a".repeat(64);
      const body = new Uint8Array(500);
      const responses = await Promise.all(
        [0, 1, 2].map(() => handler(postBlobReq(hash, body, token))),
      );
      for (const res of responses) {
        assertEquals(res.status, 200);
        await res.body?.cancel();
      }
      assertEquals(vaultBlobBytes(dataDir, vaultId), 500);
      assertEquals(vaultBytes(db, vaultId), 500);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a counter above 2^31 reads back exactly",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, token } = setup(db);
      const handler = blobRoutes(dataDir, db);
      // A literal so SQLite stores a full 64-bit integer; a binding would be the
      // same question, and a 32-bit read of 4e9 comes back negative.
      db.run(`UPDATE vaults SET stored_bytes = 4000000000 WHERE id = '${vaultId}'`);
      assertEquals(vaultBytes(db, vaultId), 4_000_000_000);

      await withBudget(5_000_000_000, async () => {
        const under = await handler(postBlobReq("a".repeat(64), new Uint8Array(10), token));
        assertEquals(under.status, 200);
        await under.body?.cancel();
      });
      await withBudget(3_900_000_000, async () => {
        const over = await handler(postBlobReq("b".repeat(64), new Uint8Array(10), token));
        assertEquals(over.status, 507);
        await over.body?.cancel();
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a compaction pass reconciles the counter with what is stored",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      // Two unreferenced blobs GC will drop, one row, one trash row.
      writeOldBlob(dataDir, vaultId, "a".repeat(64), 400);
      writeOldBlob(dataDir, vaultId, "b".repeat(64), 600);
      const row = insertVersion(
        db,
        vaultId,
        "c".repeat(64),
        0,
        new Uint8Array(60),
        ["d".repeat(64)],
        false,
        deviceId,
      );
      assert(!("conflict" in row));
      trashHead(db, vaultId, "c".repeat(64), row.version, deviceId);
      // A counter that drifted (a purge frees rows without a delta).
      db.run(`UPDATE vaults SET stored_bytes = 999999 WHERE id = '${vaultId}'`);

      await runCompaction(db, dataDir, vaultId);

      assertEquals(vaultBlobBytes(dataDir, vaultId), 0, "GC dropped both unreferenced blobs");
      // 60 bytes of enc_metadata + JSON.stringify([hash]) + the serialized trashed head.
      assertEquals(vaultBytes(db, vaultId), 60 + 68 + trashedHeadBytes(db, vaultId));
      assertEquals(vaultBytes(db, vaultId), measureVault(db, dataDir, vaultId));
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - measuring a vault counts blob files and row payloads",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      await putBlob(dataDir, vaultId, "a".repeat(64), new Uint8Array(1234));
      insertVersion(db, vaultId, "b".repeat(64), 0, new Uint8Array(60), [], false, deviceId);
      assertEquals(vaultBytes(db, vaultId), 0, "a fresh vault starts at zero");
      assertEquals(measureVault(db, dataDir, vaultId), 1234 + 60 + 2);
      assertEquals(vaultBytes(db, vaultId), 1296);
      addVaultBytes(db, vaultId, 204);
      assertEquals(vaultBytes(db, vaultId), 1500);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a copy-mode switch re-measures the vault counter",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId } = setup(db);
      // The old tree holds a blob GC has not reclaimed yet: the counter counts it.
      await putBlob(dataDir, vaultId, "a".repeat(64), new Uint8Array(5000));
      assertEquals(measureVault(db, dataDir, vaultId), 5000);

      const stagingId = createStaging(db, vaultId);
      await putBlob(dataDir, stagingId, "b".repeat(64), new Uint8Array(700));
      switchToStaging(db, dataDir, vaultId, stagingId, {
        verifier: "v",
        argon2_ops: 1,
        argon2_mem: 1 << 20,
        authHash: "h".repeat(64),
      });

      assertEquals(vaultBlobBytes(dataDir, vaultId), 700);
      assertEquals(vaultBytes(db, vaultId), 700, "the counter describes the swapped-in tree");
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - commits past the cap are refused once their row payloads fill it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      // 4000 bytes of enc_metadata per commit, no chunks, no blobs: rows alone grow the DB.
      const bigMeta = "a".repeat(4000);
      await withBudget(5000, async () => {
        for (const [i, pathHash] of ["a", "b", "c"].entries()) {
          fake.receive(
            commitMsg(pathHash.repeat(64), { parent: i === 0 ? 0 : 0, encMetadata: bigMeta }),
          );
          await new Promise((r) => setTimeout(r, 50));
        }
      });
      const acks = messages(fake.sent).filter((m) => m.type === "server_commit_ack");
      const errors = messages(fake.sent).filter((m) => m.type === "server_error");
      assertEquals(acks.length, 2, "two commits fit under the cap");
      assertEquals(errors[0]?.code, "storage_full", "the third would cross it");
      // "a".repeat(4000) decodes to 3000 stored bytes; chunk_hashes is "[]".
      assertEquals(vaultBytes(db, vaultId), 2 * (3000 + 2));
      assertEquals(storedBytes(db, vaultId), 2);
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a commit past the budget is refused with storage_full",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        fake.receive(commitMsg("a".repeat(64)));
        await new Promise((r) => setTimeout(r, 50));
      });
      const err = messages(fake.sent).find((m) => m.type === "server_error");
      assertEquals(err?.code, "storage_full");
      assertEquals(storedBytes(db, vaultId), 0, "nothing is inserted past the budget");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a delete past the budget is refused when the path has no head",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        fake.receive(commitMsg("a".repeat(64), { deleted: true }));
        await new Promise((r) => setTimeout(r, 50));
      });
      const err = messages(fake.sent).find((m) => m.type === "server_error");
      assertEquals(err?.code, "storage_full", "a delete that frees nothing is refused");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a delete past the budget lands when it removes a live head",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      insertVersion(db, vaultId, "a".repeat(64), 0, new Uint8Array([1]), [], false, deviceId);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        fake.receive(commitMsg("a".repeat(64), { deleted: true, parent: 1 }));
        await new Promise((r) => setTimeout(r, 50));
      });
      const ack = messages(fake.sent).find((m) => m.type === "server_commit_ack");
      assertEquals(ack?.version, 2);
      assert(vaultBytes(db, vaultId) > 5000, "the tombstone and its trash row count too");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a second tombstone past the cap is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      insertVersion(db, vaultId, "a".repeat(64), 0, new Uint8Array([1]), [], false, deviceId);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        fake.receive(commitMsg("a".repeat(64), { deleted: true, parent: 1 }));
        await new Promise((r) => setTimeout(r, 50));
        // The head is now the tombstone: a second delete frees nothing and adds a row.
        fake.receive(commitMsg("a".repeat(64), { deleted: true, parent: 2 }));
        await new Promise((r) => setTimeout(r, 50));
      });
      const types = messages(fake.sent).map((m) => m.type === "server_error" ? m.code : m.type);
      assertEquals(types.includes("server_commit_ack"), true, "the first tombstone lands");
      assertEquals(types.includes("storage_full"), true, "the second is refused");
      assertEquals(storedBytes(db, vaultId), 2, "only the first tombstone was inserted");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a delete carrying chunk hashes past the cap is refused",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      insertVersion(db, vaultId, "a".repeat(64), 0, new Uint8Array([1]), [], false, deviceId);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        // A "delete" that still carries 10 000 hashes is a 670 KB row, not a tombstone.
        const hashes = Array.from({ length: 10_000 }, () => "0".repeat(64));
        fake.receive(JSON.stringify({
          type: "client_commit",
          vault_id: "vault",
          path_hash: "a".repeat(64),
          parent_version: 1,
          enc_metadata: "aGk=",
          chunk_hashes: hashes,
          deleted: true,
        }));
        await new Promise((r) => setTimeout(r, 50));
      });
      const err = messages(fake.sent).find((m) => m.type === "server_error");
      assertEquals(err?.code, "storage_full");
      assertEquals(storedBytes(db, vaultId), 1, "only the seeded version is stored");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a restore past the cap is refused and the tombstone stays",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = setup(db);
      const pathHash = "a".repeat(64);
      insertVersion(db, vaultId, pathHash, 0, new Uint8Array([1]), [], false, deviceId);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        fake.receive(commitMsg(pathHash, { deleted: true, parent: 1 }));
        await new Promise((r) => setTimeout(r, 50));
      });
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 2, "the delete landed");
      await withBudget(1000, async () => {
        const one = handleRestoreOne(db, vaultId, pathHash, restoreReq(vaultId, pathHash, token));
        assertEquals(one.status, 507);
        await one.body?.cancel();
        const all = handleRestoreAll(db, vaultId, restoreAllReq(vaultId, token));
        assertEquals(all.status, 200);
        assertEquals(await all.json(), { restored: 0, skipped: 1 }, "restore-all reports a skip");
      });
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 2, "no restore row was created");
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a restore under the cap adds its row payload to the counter",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId, token } = setup(db);
      const pathHash = "a".repeat(64);
      insertVersion(db, vaultId, pathHash, 0, new Uint8Array(60), [], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);
      const before = measureVault(db, dataDir, vaultId);

      const res = handleRestoreOne(db, vaultId, pathHash, restoreReq(vaultId, pathHash, token));
      assertEquals(res.status, 200);
      const body = await res.json() as { version: number };
      assertEquals(body.version, 2);
      // The restored row stores 60 bytes of enc_metadata and "[]".
      assertEquals(vaultBytes(db, vaultId), before + 62, "the restored row counts");
      assert(
        vaultBytes(db, vaultId) >= measureVault(db, dataDir, vaultId),
        "the counter never reads under the true stored bytes",
      );
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "vault-storage - a rename note past the cap is refused and the marker still lands",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const { vaultId, deviceId } = setup(db);
      insertVersion(db, vaultId, "b".repeat(64), 0, new Uint8Array([1]), [], false, deviceId);
      db.run(`UPDATE vaults SET stored_bytes = 5000 WHERE id = '${vaultId}'`);
      const { fake, done } = connection(db, dataDir, vaultId, deviceId);
      await new Promise((r) => setTimeout(r, 50));
      await withBudget(1000, async () => {
        // The note opens the new name: refused, so the rename half-applies and the
        // client retries the note once the vault has room again.
        fake.receive(commitMsg("a".repeat(64), { renameMark: RENAME_NOTE }));
        await new Promise((r) => setTimeout(r, 50));
        // The marker closes the old name and is a plain tombstone of a live head.
        fake.receive(
          commitMsg("b".repeat(64), { deleted: true, parent: 1, renameMark: RENAME_MARKER }),
        );
        await new Promise((r) => setTimeout(r, 50));
      });
      const types = messages(fake.sent).map((m) => m.type === "server_error" ? m.code : m.type);
      assertEquals(types.includes("storage_full"), true, "the note is refused");
      assertEquals(types.includes("server_commit_ack"), true, "the marker still lands");
      const note = db.prepare(
        "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      )
        .get(vaultId, "a".repeat(64)) as { n: number };
      assertEquals(note.n, 0);
      fake.triggerClose();
      await done;
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

function trashedHeadBytes(db: Database, vaultId: string): number {
  const row = db.prepare(
    "SELECT CAST(length(head_json) AS REAL) AS n FROM trashed_heads WHERE vault_id = ?",
  )
    .get(vaultId) as { n: number } | null;
  return row?.n ?? 0;
}

function writeOldBlob(dataDir: string, vaultId: string, hash: string, size: number): void {
  const dir = `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}`;
  Deno.mkdirSync(dir, { recursive: true });
  const path = `${dir}/${hash.slice(2)}`;
  Deno.writeFileSync(path, new Uint8Array(size));
  Deno.utimeSync(path, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
}
