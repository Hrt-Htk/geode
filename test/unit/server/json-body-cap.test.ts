// #676: every route that reads a body must cap it: one authed client streaming an
// unbounded JSON body would otherwise OOM the single server process and take every
// vault down. A body past the route's cap is 413, and the read aborts at the cap
// instead of draining the stream.
import { insertVersion, openDb } from "../../../server/db.ts";
import { trashHead } from "../../../server/trash-db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { MAX_JSON_BODY } from "../../../server/http-helpers.ts";
import { MAX_REKEY_ROWS_BODY } from "../../../server/ws-commit.ts";
import { MAX_BLOB_SIZE } from "../../../server/blobs.ts";
import { authHashHex, deriveAuthKey } from "../../../core/crypto.ts";
import type { VaultKeys } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { serveOnPortZero } from "../../helpers/port.ts";
import { assert, assertEquals } from "@std/assert";
import type { Database } from "@db/sqlite";

const ADMIN = "admin-token";
const H = (c: string) => c.repeat(64);
const PATH_HASH = H("a");
const DEVICE_ID = "dev1";
const CHUNK = 64 * 1024;

// Fixed key material so the re-key auth key is computable without argon2.
const KEYS: VaultKeys = {
  content_key: new Uint8Array(32).fill(3),
  mac_key: new Uint8Array(32).fill(4),
  nonce_key: new Uint8Array(32).fill(5),
};
const AUTH_KEY_HEX = Array.from(deriveAuthKey(KEYS)).map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const AUTH_HASH = authHashHex(deriveAuthKey(KEYS));

interface Ctx {
  db: Database;
  dataDir: string;
  vaultId: string;
  token: string;
}

function setup(): Ctx {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  const vaultId = crypto.randomUUID();
  const token = `tok-${crypto.randomUUID()}`;
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at, auth_hash) VALUES(?,?,?,?,?)",
    vaultId,
    "test-vault",
    new Uint8Array(16),
    Date.now(),
    AUTH_HASH,
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    DEVICE_ID,
    vaultId,
    "test-device",
    token,
  );
  insertVersion(db, vaultId, PATH_HASH, 0, new Uint8Array([1, 2]), [H("c")], false, DEVICE_ID);
  insertVersion(db, vaultId, PATH_HASH, 1, new Uint8Array([1, 2]), [], true, DEVICE_ID);
  trashHead(db, vaultId, PATH_HASH, 1, DEVICE_ID);
  return { db, dataDir, vaultId, token };
}

// Every route that reads a request body, with the cap it must enforce. `rekeyMode`
// is the session state the route needs to reach the body read (a null mode 409s
// earlier on the session routes). The purge-one routes are reached with the admin
// token: a device purge inside the retention floor is 403 before the body (#677).
interface Case {
  name: string;
  method: string;
  path: (c: Ctx) => string;
  auth: "admin" | "device" | "rekey";
  rekeyMode?: string;
  cap: number;
}

const CASES: Case[] = [
  {
    name: "POST /vaults",
    method: "POST",
    path: () => "/vaults",
    auth: "admin",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/devices",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/devices`,
    auth: "admin",
    cap: MAX_JSON_BODY,
  },
  {
    name: "PUT …/verifier",
    method: "PUT",
    path: (c) => `/vaults/${c.vaultId}/verifier`,
    auth: "device",
    cap: MAX_JSON_BODY,
  },
  {
    name: "PUT …/name",
    method: "PUT",
    path: (c) => `/vaults/${c.vaultId}/name`,
    auth: "device",
    cap: MAX_JSON_BODY,
  },
  {
    name: "PUT …/devices/:id/name",
    method: "PUT",
    path: (c) => `/vaults/${c.vaultId}/devices/${DEVICE_ID}/name`,
    auth: "device",
    cap: MAX_JSON_BODY,
  },
  {
    name: "DELETE …/trash/:pathHash",
    method: "DELETE",
    path: (c) => `/vaults/${c.vaultId}/trash/${PATH_HASH}`,
    auth: "admin",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/trash/:pathHash/purge",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/trash/${PATH_HASH}/purge`,
    auth: "admin",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/trash/purge-expired",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/trash/purge-expired`,
    auth: "device",
    cap: MAX_JSON_BODY,
  },
  {
    name: "PUT …/auth",
    method: "PUT",
    path: (c) => `/vaults/${c.vaultId}/auth`,
    auth: "device",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/rekey",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/rekey`,
    auth: "rekey",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/rekey/switch",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/rekey/switch`,
    auth: "rekey",
    rekeyMode: "replace",
    cap: MAX_JSON_BODY,
  },
  {
    name: "POST …/rekey/rows",
    method: "POST",
    path: (c) => `/vaults/${c.vaultId}/rekey/rows`,
    auth: "rekey",
    rekeyMode: "replace",
    cap: MAX_REKEY_ROWS_BODY,
  },
  {
    name: "PUT …/rekey/blobs/:hash",
    method: "PUT",
    path: (c) => `/vaults/${c.vaultId}/rekey/blobs/${H("d")}`,
    auth: "rekey",
    rekeyMode: "replace",
    cap: MAX_BLOB_SIZE,
  },
];

function headers(c: Ctx, kase: Case): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  h.authorization = `Bearer ${kase.auth === "admin" ? ADMIN : c.token}`;
  if (kase.auth === "rekey") h["x-geode-auth-key"] = AUTH_KEY_HEX;
  return h;
}

function build(c: Ctx, kase: Case, init: RequestInit): Request {
  c.db.run("UPDATE vaults SET rekey_mode = ? WHERE id = ?", kase.rekeyMode ?? null, c.vaultId);
  return new Request(`http://localhost${kase.path(c)}`, {
    method: kase.method,
    headers: headers(c, kase),
    ...init,
  });
}

/** A chunked body (no content-length) of `total` bytes that counts what is pulled. */
function chunked(total: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = Math.min(CHUNK, total - pulled);
      pulled += size;
      controller.enqueue(new Uint8Array(size));
      if (pulled >= total) controller.close();
    },
  });
  return { body, pulled: () => pulled };
}

/** A rows batch as the client sends it: chunk_hashes is a JSON string of the array. */
function rowsBatch(rows: number, hashes: number): { versions: unknown[]; trash: unknown[] } {
  const hex = (n: number) => n.toString(16).padStart(64, "0");
  return {
    versions: Array.from({ length: rows }, (_, i) => ({
      old_path_hash: hex(i),
      row: {
        version: 1,
        parent: null,
        seq: i + 1,
        path_hash: hex(i + 1),
        enc_metadata: b64encode(new Uint8Array([7, 7])),
        chunk_hashes: JSON.stringify(Array.from({ length: hashes }, () => H("d"))),
        deleted: 0,
        device_id: DEVICE_ID,
        created_at: 123,
        compacted_range: null,
        path_ciphertext: null,
        rename_mark: 0,
      },
    })),
    trash: [],
  };
}

Deno.test({
  name: "json-body-cap - an oversized chunked body is 413 on every body route, aborted at the cap",
  async fn() {
    for (const kase of CASES) {
      const c = setup();
      try {
        const handler = vaultRoutes(c.db, ADMIN, c.dataDir);
        const total = kase.cap + 4 * CHUNK;
        const { body, pulled } = chunked(total);
        const res = await handler(build(c, kase, { body }));
        assertEquals(res.status, 413, `${kase.name} must refuse a ${total}-byte body`);
        await res.body?.cancel();
        assert(
          pulled() <= kase.cap + CHUNK,
          `${kase.name} must abort at the cap, but read ${pulled()} of ${total} bytes`,
        );
      } finally {
        c.db.close();
        removeTempDir(c.dataDir);
      }
    }
  },
});

Deno.test({
  name: "json-body-cap - an oversized content-length is 413 before any body is read",
  async fn() {
    for (const kase of CASES) {
      const c = setup();
      try {
        const handler = vaultRoutes(c.db, ADMIN, c.dataDir);
        const req = build(c, kase, {
          body: new Uint8Array(1),
          headers: { ...headers(c, kase), "content-length": String(kase.cap + 1) },
        });
        const res = await handler(req);
        assertEquals(
          res.status,
          413,
          `${kase.name} must refuse a declared ${kase.cap + 1}-byte body`,
        );
        await res.body?.cancel();
      } finally {
        c.db.close();
        removeTempDir(c.dataDir);
      }
    }
  },
});

Deno.test({
  name:
    "json-body-cap - normal and empty JSON bodies still reach their routes; the re-key rows cap is separate",
  async fn() {
    const c = setup();
    const handler = vaultRoutes(c.db, ADMIN, c.dataDir);
    const { port, shutdown, finished } = serveOnPortZero(handler);
    const url = (p: string) => `http://localhost:${port}${p}`;
    const auth = { authorization: `Bearer ${c.token}`, "content-type": "application/json" };
    try {
      // A normal request passes.
      let res = await fetch(url(`/vaults/${c.vaultId}/devices/${DEVICE_ID}/name`), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "renamed" }),
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();

      // Just over the JSON cap is 413: the cap is a boundary, not a heuristic.
      res = await fetch(url(`/vaults/${c.vaultId}/devices/${DEVICE_ID}/name`), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ name: "x".repeat(MAX_JSON_BODY) }),
      });
      assertEquals(res.status, 413);
      await res.body?.cancel();

      // An absent body still means "no chain" / "server retention", not 400.
      res = await fetch(url(`/vaults/${c.vaultId}/trash/purge-expired`), {
        method: "POST",
        headers: auth,
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();

      // A DELETE purge with no body still means "no chain", not 400.
      const adminAuth = { ...auth, authorization: `Bearer ${ADMIN}` };
      res = await fetch(url(`/vaults/${c.vaultId}/trash/${PATH_HASH}`), {
        method: "DELETE",
        headers: adminAuth,
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();

      // A rows batch carries chunk_hashes arrays: 50 whole rows, far past MAX_JSON_BODY
      // and still well under the re-key cap.
      const batch = JSON.stringify(rowsBatch(50, 400));
      assert(
        batch.length > MAX_JSON_BODY && batch.length < MAX_REKEY_ROWS_BODY,
        `the batch must sit between the two caps (got ${batch.length} bytes)`,
      );
      const rekeyHeaders = { ...auth, "x-geode-auth-key": AUTH_KEY_HEX };
      res = await fetch(url(`/vaults/${c.vaultId}/rekey`), {
        method: "POST",
        headers: rekeyHeaders,
        body: JSON.stringify({ mode: "copy" }),
      });
      assertEquals(res.status, 200);
      await res.body?.cancel();

      res = await fetch(url(`/vaults/${c.vaultId}/rekey/rows`), {
        method: "POST",
        headers: rekeyHeaders,
        body: batch,
      });
      assertEquals(res.status, 200, "a realistic 50-row batch is under the re-key cap");
      await res.body?.cancel();

      const staging = c.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(c.vaultId) as {
        id: string;
      };
      const staged = c.db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
        .get(staging.id) as { n: number };
      assertEquals(staged.n, 50, "the whole batch reached staging");
    } finally {
      await shutdown();
      await finished;
      c.db.close();
      removeTempDir(c.dataDir);
    }
  },
});

Deno.test({
  name: "json-body-cap - a chunked body under the cap still reaches its route",
  async fn() {
    const c = setup();
    try {
      const handler = vaultRoutes(c.db, ADMIN, c.dataDir);
      const payload = new TextEncoder().encode(JSON.stringify({ name: "chunky" }));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload.slice(0, 5));
          controller.enqueue(payload.slice(5));
          controller.close();
        },
      });
      const res = await handler(
        new Request(
          `http://localhost/vaults/${c.vaultId}/devices/${DEVICE_ID}/name`,
          {
            method: "PUT",
            headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
            body,
          },
        ),
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();
      const row = c.db.prepare("SELECT name FROM devices WHERE id = ?").get(DEVICE_ID) as {
        name: string;
      };
      assertEquals(row.name, "chunky");
    } finally {
      c.db.close();
      removeTempDir(c.dataDir);
    }
  },
});
