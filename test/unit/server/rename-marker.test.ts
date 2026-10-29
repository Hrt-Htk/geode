// #583: a rename marker (deleted + rename_mark 1) and the note that opens the new
// path (create + rename_mark 2) are history links, never deletions: a marker must
// never become a trash entry, and both rows survive compaction forever.
import { VaultHub } from "../../../server/ws.ts";
import { type Database, openDb } from "../../../server/db.ts";
import { listTrash } from "../../../server/trash-db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { rowToVersion } from "../../../server/ws-types.ts";
import {
  b64encode,
  type ClientCommit,
  type HeadRecord,
  headToServerVersion,
  PROTOCOL_VERSION,
  RENAME_MARKER,
  RENAME_NOTE,
} from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { assert, assertEquals } from "@std/assert";
import { makeFakeSocket } from "../../helpers/fake-socket.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const H = (c: string) => c.repeat(64);
const PATH_A = H("a");
const PATH_B = H("b");
const VAULT = "rename-marker-vault";
const CHUNK = H("c");

const ENC_META = b64encode(
  new TextEncoder().encode(
    JSON.stringify({
      path: "a.md",
      mtime: 0,
      size: 0,
      mime: "text/markdown",
      plaintext_hash: CHUNK,
    }),
  ),
);

const tick = () => new Promise((r) => setTimeout(r, 20));

function seedVault(db: Database): { vaultId: string; deviceId: string; token: string } {
  const deviceId = "dev1";
  const token = "tok-583";
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    VAULT,
    "v583",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    VAULT,
    "test-device",
    token,
  );
  return { vaultId: VAULT, deviceId, token };
}

async function connect(
  db: Database,
  dataDir: string,
  deviceId: string,
): Promise<{ fake: ReturnType<typeof makeFakeSocket>; done: Promise<void> }> {
  const hub = new VaultHub(db, dataDir, VAULT, () => {});
  const fake = makeFakeSocket();
  const done = hub.handleConnection(fake.ws, deviceId);
  fake.receive(JSON.stringify({
    type: "client_hello",
    protocol_version: PROTOCOL_VERSION,
    device_id: deviceId,
    last_seen_seq: 0,
    plugin_version: SERVER_VERSION,
  }));
  await tick();
  return { fake, done };
}

async function commit(
  fake: ReturnType<typeof makeFakeSocket>,
  over: Partial<ClientCommit>,
): Promise<void> {
  fake.receive(JSON.stringify({
    type: "client_commit",
    vault_id: VAULT,
    path_hash: PATH_A,
    parent_version: 0,
    enc_metadata: ENC_META,
    chunk_hashes: [CHUNK],
    deleted: false,
    ...over,
  }));
  await tick();
}

function getTrash(
  db: Database,
  dataDir: string,
  token: string,
): Promise<Response> {
  return vaultRoutes(db, null, dataDir)(
    new Request(`http://localhost/vaults/${VAULT}/trash`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function getVersions(
  db: Database,
  dataDir: string,
  pathHash: string,
  token: string,
): Promise<Response> {
  return vaultRoutes(db, null, dataDir)(
    new Request(`http://localhost/vaults/${VAULT}/versions/${pathHash}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

Deno.test({
  name: "rename-marker - a marker creates no trash entry, a plain delete still does (#583 §11)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { deviceId, token } = seedVault(db);
      const { fake, done } = await connect(db, dataDir, deviceId);

      // Control: a plain delete is still trashed.
      await commit(fake, { path_hash: PATH_B, parent_version: 0 });
      await commit(fake, { path_hash: PATH_B, parent_version: 1, deleted: true });
      assertEquals(listTrash(db, VAULT).map((t) => t.path_hash), [PATH_B]);

      // A marker is a history link, not a deletion.
      await commit(fake, { path_hash: PATH_A, parent_version: 0 });
      await commit(fake, {
        path_hash: PATH_A,
        parent_version: 1,
        deleted: true,
        rename_mark: RENAME_MARKER,
      });

      const res = await getTrash(db, dataDir, token);
      const body = await res.json() as { trash: Array<{ path_hash: string; version: number }> };
      assertEquals(body.trash.map((t) => t.path_hash), [PATH_B]);
      // The list carries the trashed head's version: the ceiling of the History
      // action on a trash row (#583 §13).
      assertEquals(body.trash[0].version, 1);

      fake.triggerClose();
      await done;
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rename-marker - a marker promoted over a stale tombstone clears its trash row (§6)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { deviceId } = seedVault(db);
      const { fake, done } = await connect(db, dataDir, deviceId);

      await commit(fake, { path_hash: PATH_A, parent_version: 0 });
      await commit(fake, { path_hash: PATH_A, parent_version: 1, deleted: true });
      assertEquals(listTrash(db, VAULT).length, 1, "the tombstone trashes the content head");

      // The other device renamed while this one deleted: the marker lands on top
      // of the tombstone, so the stale trash row must go.
      await commit(fake, {
        path_hash: PATH_A,
        parent_version: 2,
        deleted: true,
        rename_mark: RENAME_MARKER,
      });
      assertEquals(listTrash(db, VAULT).length, 0, "the marker clears the stale trash row");

      fake.triggerClose();
      await done;
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rename-marker - /versions carries rename_mark for a marker and a note",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { deviceId, token } = seedVault(db);
      const { fake, done } = await connect(db, dataDir, deviceId);

      await commit(fake, { path_hash: PATH_A, parent_version: 0 });
      await commit(fake, {
        path_hash: PATH_A,
        parent_version: 1,
        deleted: true,
        rename_mark: RENAME_MARKER,
      });
      await commit(fake, { path_hash: PATH_B, parent_version: 0, rename_mark: RENAME_NOTE });

      type Row = { version: number; deleted: number; rename_mark: number };
      const a = await (await getVersions(db, dataDir, PATH_A, token)).json() as Row[];
      assertEquals(a.map((r) => [r.version, r.deleted, r.rename_mark]), [[2, 1, 1], [1, 0, 0]]);
      const b = await (await getVersions(db, dataDir, PATH_B, token)).json() as Row[];
      assertEquals(b.map((r) => [r.version, r.deleted, r.rename_mark]), [[1, 0, 2]]);

      fake.triggerClose();
      await done;
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rename-marker - a plain tombstone over a marker head creates no trash entry (#596)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { deviceId, token } = seedVault(db);
      const { fake, done } = await connect(db, dataDir, deviceId);

      await commit(fake, { path_hash: PATH_A, parent_version: 0 });
      await commit(fake, {
        path_hash: PATH_A,
        parent_version: 1,
        deleted: true,
        rename_mark: RENAME_MARKER,
      });

      // A device that could not see the marker deletes the name "plainly": the
      // tombstone is accepted on top of it, but the head it closes is a rename, so
      // the name is never a trash entry (and can never be restored).
      await commit(fake, { path_hash: PATH_A, parent_version: 2, deleted: true });

      const versions = db.prepare(
        "SELECT version, parent, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
      ).all(VAULT, PATH_A) as Array<
        { version: number; parent: number; deleted: number; rename_mark: number }
      >;
      assertEquals(
        versions.map((v) => [v.version, v.parent, v.deleted, v.rename_mark]),
        [[1, 0, 0, 0], [2, 1, 1, RENAME_MARKER], [3, 2, 1, 0]],
        "the plain tombstone still lands",
      );
      assertEquals(listTrash(db, VAULT), [], "a rename-closed name is never trashed");

      const restore = await vaultRoutes(db, null, dataDir)(
        new Request(`http://localhost/vaults/${VAULT}/trash/${PATH_A}/restore`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      assertEquals(restore.status, 404, "the renamed-away name is not restorable");

      fake.triggerClose();
      await done;
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test("rename-marker - a broadcast version carries rename_mark", () => {
  const msg = rowToVersion({
    version: 2,
    parent: 1,
    seq: 2,
    path_hash: PATH_A,
    enc_metadata: ENC_META,
    chunk_hashes: "[]",
    deleted: 1,
    device_id: "dev1",
    created_at: 1,
    compacted_range: null,
    path_ciphertext: null,
    rename_mark: RENAME_MARKER,
  }, VAULT);
  assertEquals(msg.rename_mark, RENAME_MARKER);
  assert(msg.deleted);
});

Deno.test({
  name: "rename-marker - /heads carries rename_mark so a heads-based apply sees the marker",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const { deviceId, token } = seedVault(db);
      const { fake, done } = await connect(db, dataDir, deviceId);

      await commit(fake, { path_hash: PATH_A, parent_version: 0 });
      await commit(fake, {
        path_hash: PATH_A,
        parent_version: 1,
        deleted: true,
        rename_mark: RENAME_MARKER,
      });

      const res = await vaultRoutes(db, null, dataDir)(
        new Request(`http://localhost/vaults/${VAULT}/heads`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const rows = (await res.text())
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as HeadRecord);
      const head = rows.find((r) => r.path_hash === PATH_A)!;
      assertEquals([head.deleted, head.rename_mark], [true, RENAME_MARKER]);
      assertEquals(headToServerVersion(head, VAULT).rename_mark, RENAME_MARKER);

      fake.triggerClose();
      await done;
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});
