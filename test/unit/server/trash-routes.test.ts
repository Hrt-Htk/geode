import {
  handleListTrash,
  handlePurgeAll,
  handlePurgeExpired,
  handlePurgeOne,
  handleRestoreAll,
  handleRestoreOne,
  handleTrashContent,
} from "../../../server/trash.ts";
import { getCurrentHeadVersion, insertVersion, openDb } from "../../../server/db.ts";
import {
  getTrashedHead,
  getVersionRecord,
  listTrash,
  trashHead,
} from "../../../server/trash-db.ts";
import { TRASH_RETENTION_DAYS } from "../../../server/compaction.ts";
import { b64encode, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { attachRemoteAddr } from "../../../server/http-helpers.ts";
import { resetRateLimits } from "../../../server/rate-limit.ts";
import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function createVault(db: Database): { vaultId: string } {
  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
    salt,
    Date.now(),
  );
  return { vaultId };
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

function makeReq(url: string, method: string, body?: unknown, auth?: string): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  if (auth) {
    init.headers = { ...(init.headers as Record<string, string>), authorization: `Bearer ${auth}` };
  }
  return new Request(url, init);
}

// ── list ──────────────────────────────────────────────────────────────

Deno.test({
  name: "trash-routes - list: returns entries for a device token",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "aabbccdd1122";
      const encMetadata = new Uint8Array([1, 2, 3]);

      insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c1"], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const req = makeReq(`http://localhost/vaults/${vaultId}/trash`, "GET", undefined, token);
      const res = handleListTrash(db, vaultId, req);
      assertEquals(res.status, 200);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - list: 401 without token",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);

      const req = makeReq(`http://localhost/vaults/${vaultId}/trash`, "GET");
      const res = handleListTrash(db, vaultId, req);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - list: 403 with token for a different vault",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { vaultId: otherVaultId } = createVault(db);
      const { token: otherToken } = createDevice(db, otherVaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash`,
        "GET",
        undefined,
        otherToken,
      );
      const res = handleListTrash(db, vaultId, req);
      assertEquals(res.status, 403);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── restore one ───────────────────────────────────────────────────────

Deno.test({
  name: "trash-routes - restore one: restores and clears trash",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "restore001path";
      const encMetadata = new Uint8Array([10, 20, 30]);
      const chunkHashes = ["chunk_a", "chunk_b"];

      // v1: content version
      const r1 = insertVersion(db, vaultId, pathHash, 0, encMetadata, chunkHashes, false, deviceId);
      assert(!("conflict" in r1));
      assertEquals(r1.version, 1);

      // v2: delete version
      const r2 = insertVersion(db, vaultId, pathHash, 1, encMetadata, [], true, deviceId);
      assert(!("conflict" in r2));
      assertEquals(r2.version, 2);

      // Trash the content version (v1)
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
        "POST",
        null,
        token,
      );
      const res = await handleRestoreOne(db, vaultId, pathHash, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { restored: boolean; version: number; seq: number };
      assertEquals(body.restored, true);
      assertEquals(body.version, 3); // currentHead was 2, so new version is 3

      // Check db state: head version is 3 with deleted=0
      const headVersion = getCurrentHeadVersion(db, vaultId, pathHash);
      assertEquals(headVersion, 3);
      const record = getVersionRecord(db, vaultId, pathHash, 3);
      assert(record !== null);
      assertEquals(record.deleted, 0);

      // Trash entry should be gone
      const trashed = getTrashedHead(db, vaultId, pathHash);
      assertEquals(trashed, null);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #583 §13: the name was reused by a rename note: restoring the older file's
// trashed head would overwrite the new file's chain.
Deno.test({
  name: "trash-routes - restore one refuses a name reused by a rename note",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "reusedname01";

      // a.md: v1 content, v2 plain tombstone (its content lands in the trash).
      insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        new Uint8Array([1, 2, 3]),
        ["chunk_a"],
        false,
        deviceId,
      );
      insertVersion(db, vaultId, pathHash, 1, new Uint8Array([1, 2, 3]), [], true, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // Later another file is renamed TO this name: its first version is a note.
      insertVersion(
        db,
        vaultId,
        pathHash,
        2,
        new Uint8Array([4, 5, 6]),
        ["chunk_b"],
        false,
        deviceId,
        null,
        RENAME_NOTE,
      );

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
        "POST",
        null,
        token,
      );
      const res = await handleRestoreOne(db, vaultId, pathHash, req);
      assertEquals(res.status, 409);
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 3, "no version may be inserted");
      assert(getTrashedHead(db, vaultId, pathHash) !== null, "the trash row stays");

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #583 §13: the name was reused and the reusing file has since been edited, so
// its head is an ordinary content version again (`rename_mark` 0). Refusing only
// on a marker head would let the restore append the older file's content on top of
// the new file's chain, reverting it on every device.
Deno.test({
  name: "trash-routes - restore one refuses a name reused by a later file (#583 §13)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "reusedplain01";

      // a.md: v1 content, v2 plain tombstone (its content lands in the trash).
      insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        new Uint8Array([1, 2, 3]),
        ["chunk_a"],
        false,
        deviceId,
      );
      insertVersion(db, vaultId, pathHash, 1, new Uint8Array([1, 2, 3]), [], true, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // Another file is renamed TO this name (v3 = its note), then edited (v4).
      insertVersion(
        db,
        vaultId,
        pathHash,
        2,
        new Uint8Array([4, 5, 6]),
        ["chunk_b"],
        false,
        deviceId,
        null,
        RENAME_NOTE,
      );
      insertVersion(
        db,
        vaultId,
        pathHash,
        3,
        new Uint8Array([7, 8, 9]),
        ["chunk_c"],
        false,
        deviceId,
      );

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
        "POST",
        null,
        token,
      );
      const res = await handleRestoreOne(db, vaultId, pathHash, req);
      assertEquals(res.status, 409);
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 4, "no version may be inserted");
      assert(getTrashedHead(db, vaultId, pathHash) !== null, "the trash row stays");

      const allReq = makeReq(
        `http://localhost/vaults/${vaultId}/trash/restore-all`,
        "POST",
        null,
        token,
      );
      const allRes = handleRestoreAll(db, vaultId, allReq);
      const body = await allRes.json() as { restored: number; skipped: number };
      assertEquals(body, { restored: 0, skipped: 1 }, "restore-all skips it, same shape");
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 4);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #596: the name was renamed away: its closing version is a rename marker, not a
// deletion. A trash row left over from a plain delete (a peer that could not see the
// marker, or a marker whose trash bookkeeping ran after it) must never restore the
// name: that would resurrect a renamed-away name on every device (owner rule).
Deno.test({
  name: "trash-routes - restore refuses a name a rename closed (#596)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "renamedaway01";

      // a.md: v1 content, v2 plain tombstone (its content lands in the trash).
      insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        new Uint8Array([1, 2, 3]),
        ["chunk_a"],
        false,
        deviceId,
      );
      insertVersion(db, vaultId, pathHash, 1, new Uint8Array([1, 2, 3]), [], true, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      // A peer then renamed a.md away: v3 is the closing marker.
      insertVersion(
        db,
        vaultId,
        pathHash,
        2,
        new Uint8Array([4, 5, 6]),
        [],
        true,
        deviceId,
        null,
        RENAME_MARKER,
      );

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
        "POST",
        null,
        token,
      );
      const res = await handleRestoreOne(db, vaultId, pathHash, req);
      assertEquals(res.status, 409);
      assertEquals(await res.json(), { error: "restore conflict, retry" });
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 3, "no version may be inserted");
      assert(getTrashedHead(db, vaultId, pathHash) !== null, "the trash row stays");

      const allReq = makeReq(
        `http://localhost/vaults/${vaultId}/trash/restore-all`,
        "POST",
        null,
        token,
      );
      const allBody = await handleRestoreAll(db, vaultId, allReq).json() as {
        restored: number;
        skipped: number;
      };
      assertEquals(allBody, { restored: 0, skipped: 1 }, "restore-all skips it, same shape");
      assertEquals(getCurrentHeadVersion(db, vaultId, pathHash), 3);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #596 control: a name closed only by plain tombstones is still restorable: the
// refusal must key on a rename marker, not on "the head is deleted".
Deno.test({
  name: "trash-routes - restore still works when plain deletes closed the name (#596)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "plainclosed01";

      insertVersion(
        db,
        vaultId,
        pathHash,
        0,
        new Uint8Array([1, 2, 3]),
        ["chunk_a"],
        false,
        deviceId,
      );
      insertVersion(db, vaultId, pathHash, 1, new Uint8Array([1, 2, 3]), [], true, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);
      // A second, stale tombstone from another device is still just a delete.
      insertVersion(db, vaultId, pathHash, 2, new Uint8Array([1, 2, 3]), [], true, deviceId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
        "POST",
        null,
        token,
      );
      const res = await handleRestoreOne(db, vaultId, pathHash, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { restored: boolean; version: number };
      assertEquals(body.restored, true);
      assertEquals(body.version, 4);
      assertEquals(getTrashedHead(db, vaultId, pathHash), null);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── restore one: attribution ─────────────────────────────────────────

// #687: a restore is credited to the device that asked for it, marked restored, so
// that device applies its own version (it never writes its own versions to disk).
Deno.test({
  name: "trash-routes - restore one credits the requesting device with the restored mark",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "credit_restore_1";
      const encMetadata = new Uint8Array([42, 43, 44]);

      const r1 = insertVersion(db, vaultId, pathHash, 0, encMetadata, ["ch_x"], false, deviceId);
      assert(!("conflict" in r1));
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const res = await handleRestoreOne(
        db,
        vaultId,
        pathHash,
        makeReq(
          `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
          "POST",
          null,
          token,
        ),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { restored: boolean; version: number };
      assertEquals(body.restored, true);

      const record = getVersionRecord(db, vaultId, pathHash, body.version);
      assert(record !== null);
      assertEquals(record.device_id, deviceId, "the requester is credited");
      assertEquals(record.restored, 1, "the version carries the restored mark");

      // The version it copied is not a restore: the mark is per row.
      const origin = getVersionRecord(db, vaultId, pathHash, 1);
      assertEquals(origin!.restored, 0);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #687: the per-vault pseudo device is retired: no restore may create one, not even
// when a real device holds the reserved name (#330, the reason the flag exists).
Deno.test({
  name: "trash-routes - restore creates no pseudo device, even when a real device took its name",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "renamed_dev_hash";
      const encMetadata = new Uint8Array([11, 12, 13]);

      db.run("UPDATE devices SET name = 'geode-trash-restore' WHERE id = ?", deviceId);

      const r1 = insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c"], false, deviceId);
      assert(!("conflict" in r1));
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const res = await handleRestoreOne(
        db,
        vaultId,
        pathHash,
        makeReq(
          `http://localhost/vaults/${vaultId}/trash/${pathHash}/restore`,
          "POST",
          null,
          token,
        ),
      );
      assertEquals(res.status, 200);
      const body = await res.json() as { version: number };

      const record = getVersionRecord(db, vaultId, pathHash, body.version);
      assert(record !== null);
      assertEquals(record.device_id, deviceId);
      assertEquals(record.restored, 1);

      const restoreDevices = db.prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE vault_id = ? AND is_restore = 1",
      ).get(vaultId) as { n: number };
      assertEquals(restoreDevices.n, 0, "no pseudo device is created");
      const devices = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE vault_id = ?")
        .get(vaultId) as { n: number };
      assertEquals(devices.n, 1, "the restore adds no device row");

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── purge one ─────────────────────────────────────────────────────────

const ADMIN_TOKEN = "test-admin-token";

function versionsOf(db: Database, vaultId: string, pathHash: string): number[] {
  const rows = db.prepare(
    "SELECT version FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  ).all(vaultId, pathHash) as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

/** Backdate a trash row past the server's retention floor (the cutoff purge-expired uses). */
function agePastFloor(db: Database, vaultId: string, pathHash: string): void {
  const cutoff = Math.floor(Date.now() / 1000) - (TRASH_RETENTION_DAYS + 1) * 86400;
  db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ? AND path_hash = ?`)
    .run(cutoff, vaultId, pathHash);
}

/** #677: the attack: three content versions, the tombstone the attacker commits, then the
 * content head in the trash. Purging it erases the file's every content byte. */
function seedAttack(db: Database, vaultId: string, deviceId: string, pathHash: string): void {
  for (let v = 0; v < 3; v++) {
    insertVersion(db, vaultId, pathHash, v, new Uint8Array([1]), [`c${v}`], false, deviceId);
  }
  insertVersion(db, vaultId, pathHash, 3, new Uint8Array([1]), [], true, deviceId);
  trashHead(db, vaultId, pathHash, 3, deviceId);
}

Deno.test({
  name: "trash-routes - purge one (device): removes the entry past the retention floor",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "purge001hash";
      const encMetadata = new Uint8Array([5, 6, 7]);

      insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c"], false, deviceId);
      insertVersion(db, vaultId, pathHash, 1, encMetadata, [], true, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);
      agePastFloor(db, vaultId, pathHash);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}`,
        "DELETE",
        undefined,
        token,
      );
      const res = await handlePurgeOne(db, vaultId, pathHash, req, ADMIN_TOKEN);
      assertEquals(res.status, 200);
      assertEquals(listTrash(db, vaultId).length, 0, "the row is gone");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #677: a device token must not be able to erase content the server is still keeping
// for recovery. Both purge routes are gated: the POST (chain in the body) and the old
// client's DELETE.
Deno.test({
  name: "trash-routes - purge one refuses a device token inside the retention floor (#677)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "attack677hash";
      seedAttack(db, vaultId, deviceId, pathHash);

      const post = await handlePurgeOne(
        db,
        vaultId,
        pathHash,
        makeReq(`http://localhost/vaults/${vaultId}/trash/${pathHash}/purge`, "POST", {
          chain: [],
        }, token),
        ADMIN_TOKEN,
      );
      assertEquals(post.status, 403);
      assertEquals(await post.json(), { error: "purge_requires_admin" });

      const del = await handlePurgeOne(
        db,
        vaultId,
        pathHash,
        makeReq(`http://localhost/vaults/${vaultId}/trash/${pathHash}`, "DELETE", undefined, token),
        ADMIN_TOKEN,
      );
      assertEquals(del.status, 403, "the old client's route is gated the same way");

      assertEquals(versionsOf(db, vaultId, pathHash), [1, 2, 3, 4], "every version survives");
      assert(getTrashedHead(db, vaultId, pathHash) !== null, "and the row stays");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #677: the admin token is root everywhere else, so it purges any row, however fresh.
Deno.test({
  name: "trash-routes - purge one erases a row inside the retention floor with the admin token",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      const pathHash = "admin677purge";
      seedAttack(db, vaultId, deviceId, pathHash);

      const res = await handlePurgeOne(
        db,
        vaultId,
        pathHash,
        makeReq(`http://localhost/vaults/${vaultId}/trash/${pathHash}/purge`, "POST", {
          chain: [],
        }, ADMIN_TOKEN),
        ADMIN_TOKEN,
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { purged: true, versions: 3 });
      assertEquals(versionsOf(db, vaultId, pathHash), [4], "the tombstone stays, the saves go");
      assert(getTrashedHead(db, vaultId, pathHash) === null, "and the row is gone");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #677: past the floor the server would purge the row by itself (purge-expired, every
// compaction pass), so a device token may do it too.
Deno.test({
  name: "trash-routes - purge one erases a row past the retention floor with a device token",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "devold677hsh";
      seedAttack(db, vaultId, deviceId, pathHash);
      agePastFloor(db, vaultId, pathHash);

      const res = await handlePurgeOne(
        db,
        vaultId,
        pathHash,
        makeReq(`http://localhost/vaults/${vaultId}/trash/${pathHash}/purge`, "POST", {
          chain: [],
        }, token),
        ADMIN_TOKEN,
      );
      assertEquals(res.status, 200);
      assertEquals(versionsOf(db, vaultId, pathHash), [4]);
      assert(getTrashedHead(db, vaultId, pathHash) === null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// #677: accepting the admin token on this route must not make it a free oracle: a bearer
// that is neither the admin token nor a device of this vault is charged like adminGate
// (#560), while a real device purge never is.
Deno.test({
  name: "trash-routes - purge one charges an admin-token guess and rate-limits it (#677)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "oracle677hash";
      seedAttack(db, vaultId, deviceId, pathHash);

      const req = (bearer?: string) => {
        const r = makeReq(
          `http://localhost/vaults/${vaultId}/trash/${pathHash}/purge`,
          "POST",
          { chain: [] },
          bearer,
        );
        attachRemoteAddr(r, { transport: "tcp", hostname: "203.0.113.9", port: 1234 } as Deno.Addr);
        return r;
      };

      try {
        // No bearer at all is not an admin guess: a plain 401 that charges nothing.
        const none = await handlePurgeOne(db, vaultId, pathHash, req(), ADMIN_TOKEN);
        assertEquals(none.status, 401);

        // Five wrong bearers from one IP: each answered 401 and charged.
        for (let i = 1; i <= 5; i++) {
          const res = await handlePurgeOne(db, vaultId, pathHash, req(`guess-${i}`), ADMIN_TOKEN);
          assertEquals(res.status, 401, `guess ${i} is a 401`);
        }
        assertEquals(versionsOf(db, vaultId, pathHash), [1, 2, 3, 4], "no guess erased anything");

        // The sixth is rate-limited instead of another free attempt.
        const limited = await handlePurgeOne(db, vaultId, pathHash, req("guess-6"), ADMIN_TOKEN);
        assertEquals(limited.status, 429, "an unlimited admin-token oracle otherwise");
        assert(limited.headers.get("retry-after") !== null, "and says when to retry");

        // The window throttles guesses only: a real device purge past the floor still works.
        agePastFloor(db, vaultId, pathHash);
        const device = await handlePurgeOne(db, vaultId, pathHash, req(token), ADMIN_TOKEN);
        assertEquals(device.status, 200, "a device purge is never charged");
        assertEquals(versionsOf(db, vaultId, pathHash), [4]);
      } finally {
        resetRateLimits();
      }
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── purge-expired ─────────────────────────────────────────────────────

Deno.test({
  name: "trash-routes - purge-expired: removes old entries, keeps recent",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const oldHash = "old_path_hash_x";
      const newHash = "new_path_hash_y";
      const encMetadata = new Uint8Array([1]);

      insertVersion(db, vaultId, oldHash, 0, encMetadata, [], false, deviceId);
      trashHead(db, vaultId, oldHash, 1, deviceId);

      insertVersion(db, vaultId, newHash, 0, encMetadata, [], false, deviceId);
      trashHead(db, vaultId, newHash, 1, deviceId);

      // Backdate the old entry past 30 days
      const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE path_hash = ?`).run(
        oldTimestamp,
        oldHash,
      );

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-expired`,
        "POST",
        { retention_days: 30 },
        token,
      );
      const res = await handlePurgeExpired(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { purged: number };
      assertEquals(body.purged, 1);

      // Only the recent entry remains (vault-global check)
      const remaining = listTrash(db, vaultId);
      assertEquals(remaining.length, 1);
      assertEquals(remaining[0].path_hash, newHash);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name:
    "trash-routes - purge-expired: retention_days below the server floor cannot purge fresh trash",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "floor_guard_hash";
      const encMetadata = new Uint8Array([3]);

      // Trashed 5 days ago: fresh against the server's retention floor.
      insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c"], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);
      const fresh = Math.floor(Date.now() / 1000) - 5 * 24 * 3600;
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE path_hash = ?`).run(
        fresh,
        pathHash,
      );

      // A stolen device token tries to wipe the trash now (retention_days: 0).
      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-expired`,
        "POST",
        { retention_days: 0 },
        token,
      );
      const res = await handlePurgeExpired(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { purged: number };
      assertEquals(body.purged, 0, "server floor must protect fresh trash from retention_days: 0");
      assertEquals(listTrash(db, vaultId).length, 1, "fresh trash entry must survive");

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - purge-expired: retention_days above the server floor is honored",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "floor_above_hash";
      const encMetadata = new Uint8Array([4]);

      // Trashed 65 days ago: expired under a 60-day client retention (above the floor).
      insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c"], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);
      const old = Math.floor(Date.now() / 1000) - 65 * 24 * 3600;
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE path_hash = ?`).run(old, pathHash);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-expired`,
        "POST",
        { retention_days: 60 },
        token,
      );
      const res = await handlePurgeExpired(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { purged: number };
      assertEquals(body.purged, 1, "a client retention above the floor must still purge");
      assertEquals(listTrash(db, vaultId).length, 0);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - list: response carries the server retention_days floor",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { token } = createDevice(db, vaultId);

      const req = makeReq(`http://localhost/vaults/${vaultId}/trash`, "GET", undefined, token);
      const res = handleListTrash(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { trash: unknown[]; retention_days?: number };
      assertEquals(
        body.retention_days,
        TRASH_RETENTION_DAYS,
        "client must be able to display the server's real purge cutoff",
      );

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - purge-expired: does not purge another vault's trash",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { vaultId: otherVaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const encMetadata = new Uint8Array([2]);

      // Expired trash in both vaults
      insertVersion(db, vaultId, "vault_a_old_hash", 0, encMetadata, [], false, deviceId);
      trashHead(db, vaultId, "vault_a_old_hash", 1, deviceId);

      insertVersion(db, otherVaultId, "vault_b_old_hash", 0, encMetadata, [], false, deviceId);
      trashHead(db, otherVaultId, "vault_b_old_hash", 1, deviceId);

      const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ?`).run(
        oldTimestamp,
        vaultId,
      );
      db.prepare(`UPDATE trashed_heads SET trashed_at = ? WHERE vault_id = ?`).run(
        oldTimestamp,
        otherVaultId,
      );

      // Purge from vault A's device
      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-expired`,
        "POST",
        { retention_days: 30 },
        token,
      );
      const res = await handlePurgeExpired(db, vaultId, req);
      assertEquals(res.status, 200);

      // Vault A's trash is gone, vault B's remains untouched
      assertEquals(listTrash(db, vaultId).length, 0);
      const otherTrash = listTrash(db, otherVaultId);
      assertEquals(otherTrash.length, 1);
      assertEquals(otherTrash[0].path_hash, "vault_b_old_hash");

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── purge-all ────────────────────────────────────────────────────────

Deno.test({
  name: "trash-routes - purge-all: 401 with a device token",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { token } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-all`,
        "POST",
        null,
        token,
      );
      const adminToken = "super-secret-admin-token";
      const res = handlePurgeAll(db, vaultId, req, adminToken);
      assertEquals(res.status, 401);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - purge-all: empties trash with admin token",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId } = createDevice(db, vaultId);
      const adminToken = "super-secret-admin-token";
      const encMetadata = new Uint8Array([9]);

      for (const ph of ["hash001", "hash002", "hash003"]) {
        insertVersion(db, vaultId, ph, 0, encMetadata, [], false, deviceId);
        trashHead(db, vaultId, ph, 1, deviceId);
      }

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/purge-all`,
        "POST",
        null,
        adminToken,
      );
      const res = handlePurgeAll(db, vaultId, req, adminToken);
      assertEquals(res.status, 200);
      const body = await res.json() as { purged: number };
      assertEquals(body.purged, 3);

      assertEquals(listTrash(db, vaultId).length, 0);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── restore-all ───────────────────────────────────────────────────────

Deno.test({
  name: "trash-routes - restore-all: restores two files, trash becomes empty",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const encMetadata = new Uint8Array([7, 8]);

      for (const ph of ["file_a_hash", "file_b_hash"]) {
        // v1: content
        insertVersion(db, vaultId, ph, 0, encMetadata, ["c"], false, deviceId);
        // v2: delete
        insertVersion(db, vaultId, ph, 1, encMetadata, [], true, deviceId);
        // Trash the content version (v1)
        trashHead(db, vaultId, ph, 1, deviceId);
      }

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/restore-all`,
        "POST",
        null,
        token,
      );
      const res = handleRestoreAll(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { restored: number; skipped: number };
      assertEquals(body.restored, 2);
      assertEquals(body.skipped, 0);

      assertEquals(listTrash(db, vaultId).length, 0);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── list: enc_metadata (#455 preview) ────────────────────────────────

Deno.test({
  name: "trash-routes - list: entries carry base64 enc_metadata (additive, for preview size/type)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "meta_roundtrip_hash";
      const encMetadata = new Uint8Array([9, 8, 7, 6]);

      insertVersion(db, vaultId, pathHash, 0, encMetadata, ["c1"], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const req = makeReq(`http://localhost/vaults/${vaultId}/trash`, "GET", undefined, token);
      const res = handleListTrash(db, vaultId, req);
      assertEquals(res.status, 200);
      const body = await res.json() as {
        trash: Array<{ path_hash: string; enc_metadata?: string }>;
      };
      const entry = body.trash.find((e) => e.path_hash === pathHash);
      assert(entry !== undefined, "trashed entry present");
      assertEquals(entry.enc_metadata, b64encode(encMetadata));

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── content (#455 preview fetch) ──────────────────────────────────────

Deno.test({
  name: "trash-routes - content: returns chunk hashes + enc_metadata for a trashed file",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "content_fetch_hash";
      const encMetadata = new Uint8Array([1, 5, 9]);
      const chunkHashes = ["chunk_alpha", "chunk_beta"];

      insertVersion(db, vaultId, pathHash, 0, encMetadata, chunkHashes, false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/${pathHash}/content`,
        "GET",
        undefined,
        token,
      );
      const res = handleTrashContent(db, vaultId, pathHash, req);
      assertEquals(res.status, 200);
      const body = await res.json() as { chunk_hashes: string[]; enc_metadata: string };
      assertEquals(body.chunk_hashes, chunkHashes);
      assertEquals(body.enc_metadata, b64encode(encMetadata));

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - content: 403 with token for a different vault",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { vaultId: otherVaultId } = createVault(db);
      const { token: otherToken } = createDevice(db, otherVaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/some_hash/content`,
        "GET",
        undefined,
        otherToken,
      );
      const res = handleTrashContent(db, vaultId, "some_hash", req);
      assertEquals(res.status, 403);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - content: 404 when path is not in the trash",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { token } = createDevice(db, vaultId);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/never_trashed/content`,
        "GET",
        undefined,
        token,
      );
      const res = handleTrashContent(db, vaultId, "never_trashed", req);
      assertEquals(res.status, 404);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "trash-routes - content: 401 without a device token",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);

      const req = makeReq(
        `http://localhost/vaults/${vaultId}/trash/some_hash/content`,
        "GET",
      );
      const res = handleTrashContent(db, vaultId, "some_hash", req);
      assertEquals(res.status, 401);

      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── re-key session block (#556) ──────────────────────────────────────

Deno.test({
  name:
    "trash-routes - mutating routes refuse 409 rekey_in_progress during a session; read-only stays open",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { vaultId } = createVault(db);
      const { deviceId, token } = createDevice(db, vaultId);
      const pathHash = "aabbccdd1122";
      insertVersion(db, vaultId, pathHash, 0, new Uint8Array([1, 2, 3]), ["c1"], false, deviceId);
      trashHead(db, vaultId, pathHash, 1, deviceId);

      db.run("UPDATE vaults SET rekey_mode = 'copy' WHERE id = ?", vaultId);

      const authReq = (url: string, method: string) => makeReq(url, method, undefined, token);
      const handlers: Array<() => Response | Promise<Response>> = [
        () =>
          handleRestoreOne(
            db,
            vaultId,
            pathHash,
            authReq(`http://x/vaults/${vaultId}/trash/${pathHash}/restore`, "POST"),
          ),
        () =>
          handleRestoreAll(
            db,
            vaultId,
            authReq(`http://x/vaults/${vaultId}/trash/restore-all`, "POST"),
          ),
        () =>
          handlePurgeOne(
            db,
            vaultId,
            pathHash,
            authReq(`http://x/vaults/${vaultId}/trash/${pathHash}`, "DELETE"),
            ADMIN_TOKEN,
          ),
        () =>
          handlePurgeExpired(
            db,
            vaultId,
            authReq(`http://x/vaults/${vaultId}/trash/purge-expired`, "POST"),
          ),
        () =>
          handlePurgeAll(
            db,
            vaultId,
            makeReq(`http://x/vaults/${vaultId}/trash/purge-all`, "POST", undefined, "admin-token"),
            "admin-token",
          ),
      ];
      for (const handler of handlers) {
        const res = await handler();
        assertEquals(
          res.status,
          409,
          `expected 409 during re-key: ${JSON.stringify(await res.clone().json())}`,
        );
        const body = await res.json() as { error: string };
        assertEquals(body.error, "rekey_in_progress");
      }

      // Read-only trash listing stays open during a session.
      const listRes = handleListTrash(
        db,
        vaultId,
        authReq(`http://x/vaults/${vaultId}/trash`, "GET"),
      );
      assertEquals(listRes.status, 200);

      // After the session ends, the routes work again.
      db.run("UPDATE vaults SET rekey_mode = NULL WHERE id = ?", vaultId);
      const restoreRes = handleRestoreOne(
        db,
        vaultId,
        pathHash,
        authReq(`http://x/vaults/${vaultId}/trash/${pathHash}/restore`, "POST"),
      );
      assertEquals(restoreRes.status, 200);
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});
