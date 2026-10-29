import { type Database, insertVersion, openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { blobRoutes } from "../../../server/blob-routes.ts";
import { VaultHub } from "../../../server/ws.ts";
import { authHashHex, deriveAuthKey } from "../../../core/crypto.ts";
import type { VaultKeys } from "../../../core/crypto.ts";
import { b64encode, PROTOCOL_VERSION, RENAME_MARKER } from "../../../core/protocol.ts";
import { SERVER_VERSION } from "../../../server/version-gate.ts";
import { MAX_ENC_METADATA_LEN, MAX_PATH_CIPHERTEXT_LEN } from "../../../server/ws-commit.ts";
import { makeFakeSocket } from "../../helpers/fake-socket.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { serveOnPortZero } from "../../helpers/port.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";

const H = (c: string) => c.repeat(64);
const ADMIN_TOKEN = "test-admin-token";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Fixed key material so tests can compute the auth secret without argon2.
const KEYS: VaultKeys = {
  content_key: new Uint8Array(32).fill(3),
  mac_key: new Uint8Array(32).fill(4),
  nonce_key: new Uint8Array(32).fill(5),
};
const AUTH_KEY_HEX = Array.from(deriveAuthKey(KEYS)).map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const AUTH_HASH = authHashHex(deriveAuthKey(KEYS));
const NEW_AUTH_HASH = authHashHex(new Uint8Array(32).fill(9));

interface Setup {
  db: Database;
  dataDir: string;
  vaultId: string;
  token: string;
  otherVaultId: string;
  otherToken: string;
}

function setup(): Setup {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  const vaultId = crypto.randomUUID();
  const token = `tok-${crypto.randomUUID()}`;
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at, verifier, argon2_ops, argon2_mem) VALUES(?,?,?,?,?,?,?)",
    vaultId,
    "test-vault",
    new Uint8Array(16),
    Date.now(),
    "old-verifier",
    1,
    2,
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    "dev1",
    vaultId,
    "test-device",
    token,
  );
  const otherVaultId = crypto.randomUUID();
  const otherToken = `tok-${crypto.randomUUID()}`;
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    otherVaultId,
    "other",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    "dev2",
    otherVaultId,
    "other-device",
    otherToken,
  );
  return { db, dataDir, vaultId, token, otherVaultId, otherToken };
}

async function withServer(
  dataDir: string,
  db: Database,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const handler = vaultRoutes(db, ADMIN_TOKEN, dataDir);
  const { port, shutdown, finished } = serveOnPortZero(handler);
  try {
    await fn(port);
  } finally {
    await shutdown();
    await finished;
  }
}

async function withBlobServer(
  dataDir: string,
  db: Database,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const handler = blobRoutes(dataDir, db);
  const { port, shutdown, finished } = serveOnPortZero(handler);
  try {
    await fn(port);
  } finally {
    await shutdown();
    await finished;
  }
}

function req(
  port: number,
  path: string,
  opts: {
    method?: string;
    token?: string;
    authKey?: string;
    adminToken?: string;
    body?: unknown | Uint8Array;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.authKey !== undefined) headers["x-geode-auth-key"] = opts.authKey;
  if (opts.adminToken !== undefined) headers["x-geode-admin-token"] = opts.adminToken;
  let body: BodyInit | undefined;
  if (opts.body instanceof Uint8Array) body = opts.body;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`http://localhost:${port}${path}`, { method: opts.method ?? "GET", headers, body });
}

function registerAuth(port: number, vaultId: string, token: string): Promise<Response> {
  return req(port, `/vaults/${vaultId}/auth`, {
    method: "PUT",
    token,
    adminToken: ADMIN_TOKEN,
    body: { auth_key: AUTH_KEY_HEX },
  });
}

function startRekey(port: number, vaultId: string, token: string, mode: string): Promise<Response> {
  return req(port, `/vaults/${vaultId}/rekey`, {
    method: "POST",
    token,
    authKey: AUTH_KEY_HEX,
    body: { mode },
  });
}

function seedVersion(db: Database, vaultId: string, pathHash: string): void {
  insertVersion(db, vaultId, pathHash, 0, new Uint8Array([1, 2]), [H("c")], false, "dev1");
}

function blobPath(dataDir: string, vaultId: string, hash: string): string {
  return `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`;
}

/** Make the storage counter's re-measure throw, the way a failed blob walk would. */
function breakStoredBytes(db: Database): void {
  const run = db.run.bind(db);
  db.run = ((sql: string, ...params: import("@db/sqlite").BindValue[]) => {
    if (sql.includes("stored_bytes =")) throw new Error("blob walk failed");
    return run(sql, ...params);
  }) as typeof db.run;
}

function rowsBody(oldPathHash: string, newPathHash: string, renameMark = 0) {
  return {
    versions: [{
      old_path_hash: oldPathHash,
      row: {
        version: 1,
        parent: null,
        seq: 1,
        path_hash: newPathHash,
        enc_metadata: b64encode(new Uint8Array([7, 7])),
        chunk_hashes: JSON.stringify([H("d")]),
        deleted: 0,
        device_id: "dev1",
        created_at: 123,
        compacted_range: null,
        path_ciphertext: null,
        rename_mark: renameMark,
      },
    }],
    trash: [],
  };
}

// ── Migration ────────────────────────────────────────────────────────

Deno.test({
  name: "rekey - migration 014 adds auth_hash + rekey_mode (fresh DB)",
  fn() {
    const dataDir = makeTempDataDir();
    try {
      const db = openDb(dataDir);
      const cols = db.prepare("PRAGMA table_info(vaults)").all() as Array<
        { name: string; notnull: number }
      >;
      for (const name of ["auth_hash", "rekey_mode"]) {
        const col = cols.find((c) => c.name === name);
        assertEquals(col !== undefined, true, `vaults must have a ${name} column`);
        assertEquals(col!.notnull, 0, `${name} must be nullable`);
      }
      db.close();
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - migration 014 applies on an existing pre-014 DB",
  fn() {
    const dataDir = makeTempDataDir();
    const migDir = makeTempDataDir();
    try {
      const realDir = `${import.meta.dirname}/../../../db/migrations`;
      for (const entry of Deno.readDirSync(realDir)) {
        // Every migration from 014 on is a separate step, not part of the pre-014 schema.
        if (parseInt(entry.name.slice(0, 3), 10) >= 14) continue;
        Deno.copyFileSync(`${realDir}/${entry.name}`, `${migDir}/${entry.name}`);
      }
      const db1 = openDb(dataDir, migDir);
      const v1 = db1.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(v1.value, "13");
      db1.close();
      Deno.copyFileSync(`${realDir}/014_rekey_auth.sql`, `${migDir}/014_rekey_auth.sql`);
      const db2 = openDb(dataDir, migDir);
      const v2 = db2.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assertEquals(v2.value, "14");
      const row = db2.prepare("SELECT auth_hash, rekey_mode FROM vaults").get() as {
        auth_hash: string | null;
        rekey_mode: string | null;
      } | null;
      assertEquals(row?.auth_hash ?? null, null);
      assertEquals(row?.rekey_mode ?? null, null);
      db2.close();
    } finally {
      removeTempDir(dataDir);
      removeTempDir(migDir);
    }
  },
});

// ── Auth registration (TOFU) ─────────────────────────────────────────

Deno.test({
  name:
    "rekey - PUT /auth: no token 401, wrong vault 403, registers once, same key again 200, different key 409",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        let res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(res.status, 401);
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.otherToken,
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();

        res = await registerAuth(port, s.vaultId, s.token);
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const stored = s.db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(s.vaultId) as {
          auth_hash: string | null;
        };
        assertEquals(stored.auth_hash, AUTH_HASH);

        // Same key again (every unlock re-registers): idempotent 200.
        res = await registerAuth(port, s.vaultId, s.token);
        assertEquals(res.status, 200);
        await res.body?.cancel();

        // A different key can't replace the registered one.
        res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.token,
          body: { auth_key: "ab".repeat(32) },
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();
        const still = s.db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(s.vaultId) as {
          auth_hash: string | null;
        };
        assertEquals(still.auth_hash, AUTH_HASH);
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// #675: TOFU registration was the takeover: whoever wrote auth_hash first owned
// every /rekey route, so the first write needs proof the device token can't give.
Deno.test({
  name: "rekey - PUT /auth: the first auth_hash needs the admin token; a device token alone is 403",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        let res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.token,
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();
        const stored = s.db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(s.vaultId) as {
          auth_hash: string | null;
        };
        assertEquals(stored.auth_hash, null, "a device token alone must not write auth_hash");

        // A wrong admin token is refused exactly like a missing one.
        res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.token,
          adminToken: "not-the-admin-token",
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();

        // Admin token + the vault's device token registers.
        res = await registerAuth(port, s.vaultId, s.token);
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const registered = s.db.prepare("SELECT auth_hash FROM vaults WHERE id = ?").get(
          s.vaultId,
        ) as {
          auth_hash: string | null;
        };
        assertEquals(registered.auth_hash, AUTH_HASH);

        // Once registered, the admin token is not needed any more.
        res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.token,
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// Every unlock re-sends a device-only registration: it must stay a plain 403 and
// never consume the IP's admin-failure budget (5 failures / 15 min).
Deno.test({
  name: "rekey - PUT /auth without the admin header is a 403 that never rate-limits admin routes",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        for (let i = 1; i <= 6; i++) {
          const res = await req(port, `/vaults/${s.vaultId}/auth`, {
            method: "PUT",
            token: s.token,
            body: { auth_key: AUTH_KEY_HEX },
          });
          assertEquals(res.status, 403, `attempt ${i}`);
          await res.body?.cancel();
        }
        // The admin-token route itself: bearer auth, so it 429s once the budget is gone.
        const admin = await req(port, "/vaults", { token: ADMIN_TOKEN });
        assertEquals(
          admin.status,
          200,
          "a device-only registration must not exhaust the admin rate limit",
        );
        await admin.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// The three-request takeover from the issue, verbatim: register, start, switch.
Deno.test({
  name: "rekey - #675: a stolen device token can neither register, start nor switch a re-key",
  async fn() {
    const s = setup();
    const attackerKey = "cc".repeat(32);
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        let res = await req(port, `/vaults/${s.vaultId}/auth`, {
          method: "PUT",
          token: s.token,
          body: { auth_key: attackerKey },
        });
        assertEquals(res.status, 403, "step 1: register an attacker-owned auth key");
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          token: s.token,
          authKey: attackerKey,
          body: { mode: "replace" },
        });
        assertEquals(res.status, 409, "step 2: start a replace re-key");
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: attackerKey,
          body: {
            verifier: "attacker-verifier",
            argon2_ops: 1,
            argon2_mem: 8 * MIB,
            auth_hash: attackerKey,
          },
        });
        assertEquals(res.status, 409, "step 3: switch the verifier and the KDF params");
        await res.body?.cancel();
      });

      const v = s.db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem, auth_hash, rekey_mode FROM vaults WHERE id = ?",
      ).get(s.vaultId) as {
        verifier: string;
        argon2_ops: number;
        argon2_mem: number;
        auth_hash: string | null;
        rekey_mode: string | null;
      };
      assertEquals(v.verifier, "old-verifier");
      assertEquals(v.argon2_ops, 1);
      assertEquals(v.argon2_mem, 2);
      assertEquals(v.auth_hash, null);
      assertEquals(v.rekey_mode, null);
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// #675: a switch hands every client the KDF params it derives with: an
// unbounded mem is an unbounded Argon2 allocation on every device.
Deno.test({
  name: "rekey - switch rejects out-of-band argon2 params with 400 and keeps the vault's",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());

        for (const [ops, mem] of [[0, 8 * MIB], [11, 8 * MIB], [1, 8 * MIB - 1], [1, GIB + 1]]) {
          const res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
            method: "POST",
            token: s.token,
            authKey: AUTH_KEY_HEX,
            body: { verifier: "v", argon2_ops: ops, argon2_mem: mem, auth_hash: NEW_AUTH_HASH },
          });
          assertEquals(res.status, 400, `ops ${ops} / mem ${mem} must be refused`);
          await res.body?.cancel();
        }
        const untouched = s.db.prepare(
          "SELECT verifier, argon2_ops, argon2_mem FROM vaults WHERE id = ?",
        )
          .get(s.vaultId) as { verifier: string; argon2_ops: number; argon2_mem: number };
        assertEquals(untouched.verifier, "old-verifier");
        assertEquals(untouched.argon2_ops, 1);
        assertEquals(untouched.argon2_mem, 2);

        // The band edges stay valid.
        const res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: { verifier: "v", argon2_ops: 1, argon2_mem: 8 * MIB, auth_hash: NEW_AUTH_HASH },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const switched = s.db.prepare("SELECT argon2_ops, argon2_mem FROM vaults WHERE id = ?")
          .get(s.vaultId) as { argon2_ops: number; argon2_mem: number };
        assertEquals(switched.argon2_ops, 1);
        assertEquals(switched.argon2_mem, 8 * MIB);
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// #675: the band binds a *change*: the change-passphrase flow re-sends the
// vault's stored params (`rekey-modal.ts`), so pre-band pairs must still pass.
Deno.test({
  name: "rekey - switch accepts the vault's stored legacy params unchanged",
  async fn() {
    const s = setup();
    try {
      // The old defaults: ops 2, 64 KiB: below the band, already stored.
      s.db.run(
        "UPDATE vaults SET argon2_ops = ?, argon2_mem = ? WHERE id = ?",
        2,
        65536,
        s.vaultId,
      );
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: {
            verifier: "new-verifier",
            argon2_ops: 2,
            argon2_mem: 65536,
            auth_hash: NEW_AUTH_HASH,
          },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });
      const v = s.db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem, rekey_mode FROM vaults WHERE id = ?",
      )
        .get(s.vaultId) as {
          verifier: string;
          argon2_ops: number;
          argon2_mem: number;
          rekey_mode: string | null;
        };
      assertEquals(v.verifier, "new-verifier");
      assertEquals(v.argon2_ops, 2);
      assertEquals(v.argon2_mem, 65536);
      assertEquals(v.rekey_mode, null);
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// ── Session start / auth gate ────────────────────────────────────────

Deno.test({
  name:
    "rekey - POST /rekey: no token 401, no key 403, wrong key 403, unregistered 409, valid copy start, second start 409",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        let res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          body: { mode: "copy" },
        });
        assertEquals(res.status, 401);
        await res.body?.cancel();

        // Unregistered auth_hash → 409 (no key can match a NULL hash).
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          token: s.token,
          body: { mode: "copy" },
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: { mode: "copy" },
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();

        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());

        // No auth key header → 403.
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          token: s.token,
          body: { mode: "copy" },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();

        // Wrong auth key → 403.
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "POST",
          token: s.token,
          authKey: "f".repeat(64),
          body: { mode: "copy" },
        });
        assertEquals(res.status, 403);
        await res.body?.cancel();

        // Valid start: staging vault created, mode set.
        res = await startRekey(port, s.vaultId, s.token, "copy");
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const mode = s.db.prepare("SELECT rekey_mode FROM vaults WHERE id = ?").get(s.vaultId) as {
          rekey_mode: string | null;
        };
        assertEquals(mode.rekey_mode, "copy");
        const staging = s.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(s.vaultId) as {
          id: string;
        } | null;
        assert(staging, "copy start must create a staging vault");

        // Second start refused while a session is open.
        res = await startRekey(port, s.vaultId, s.token, "copy");
        assertEquals(res.status, 409);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - GET /rekey reports mode + rows done",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        let res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          token: s.token,
          authKey: AUTH_KEY_HEX,
        });
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { mode: null, rows_done: null });

        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          token: s.token,
          authKey: AUTH_KEY_HEX,
        });
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { mode: "copy", rows_done: { versions: 0, trash: 0 } });
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// ── Sync block ───────────────────────────────────────────────────────

Deno.test({
  name: "rekey - blob PUT refused during a session, accepted after",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
      });
      const body = new TextEncoder().encode("blob during rekey");
      await withBlobServer(s.dataDir, s.db, async (port) => {
        let res = await req(port, `/blobs/${H("a")}`, { method: "POST", token: s.token, body });
        assertEquals(res.status, 409);
        await res.body?.cancel();
        s.db.run("UPDATE vaults SET rekey_mode = NULL WHERE id = ?", s.vaultId);
        res = await req(port, `/blobs/${H("a")}`, { method: "POST", token: s.token, body });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name:
    "rekey - WS commit refused with rekey_in_progress during a session; hello_ack rekey flag; accepted after",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const s = setup();
    try {
      s.db.run("UPDATE vaults SET rekey_mode = 'copy' WHERE id = ?", s.vaultId);
      const hub = new VaultHub(s.db, s.dataDir, s.vaultId, () => {});
      const fake = makeFakeSocket();
      const p = hub.handleConnection(fake.ws, "dev1");

      fake.receive(JSON.stringify({
        type: "client_hello",
        protocol_version: PROTOCOL_VERSION,
        device_id: "dev1",
        last_seen_seq: 0,
        plugin_version: SERVER_VERSION,
      }));
      await new Promise((r) => setTimeout(r, 50));

      const ack = JSON.parse(fake.sent[0] ?? "{}") as { type: string; rekey?: boolean };
      assertEquals(ack.type, "server_hello_ack");
      assertEquals(ack.rekey, true, "hello_ack must carry rekey: true while a session is open");

      const commit = JSON.stringify({
        type: "client_commit",
        vault_id: s.vaultId,
        path_hash: H("b"),
        parent_version: 0,
        enc_metadata: b64encode(new Uint8Array([1])),
        chunk_hashes: [H("c")],
        deleted: false,
      });
      fake.receive(commit);
      await new Promise((r) => setTimeout(r, 50));
      const err = JSON.parse(fake.sent[1] ?? "{}") as { type: string; code: string };
      assertEquals(err.type, "server_error");
      assertEquals(err.code, "rekey_in_progress");

      // After the session ends, commits flow again.
      s.db.run("UPDATE vaults SET rekey_mode = NULL WHERE id = ?", s.vaultId);
      fake.receive(commit);
      await new Promise((r) => setTimeout(r, 50));
      const ack2 = JSON.parse(fake.sent[2] ?? "{}") as { type: string };
      assertEquals(ack2.type, "server_commit_ack");

      fake.triggerClose();
      await p;
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// ── Copy end-to-end ──────────────────────────────────────────────────

Deno.test({
  name: "rekey - copy: start → blobs → rows → switch; heads show new rows, verifier/params changed",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        let res = await startRekey(port, s.vaultId, s.token, "copy");
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const stagingId =
          (s.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(s.vaultId) as {
            id: string;
          }).id;

        // Blob goes to the staging vault dir, not V's.
        const blob = new TextEncoder().encode("rekeyed chunk");
        res = await req(port, `/vaults/${s.vaultId}/rekey/blobs/${H("d")}`, {
          method: "PUT",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: blob,
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(
          Deno.readTextFileSync(blobPath(s.dataDir, stagingId, H("d"))),
          "rekeyed chunk",
        );
        assertThrows(() => Deno.statSync(`${s.dataDir}/blobs/${s.vaultId}`), Deno.errors.NotFound);

        // Rows: rewrite the version row under a new path hash into staging.
        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();

        // Switch with new verifier + params + auth hash.
        res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: {
            verifier: "new-verifier",
            argon2_ops: 3,
            argon2_mem: 64 * MIB,
            auth_hash: NEW_AUTH_HASH,
          },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });

      // Vault row: params + verifier + auth hash changed, mode cleared, staging gone.
      const v = s.db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem, auth_hash, rekey_mode FROM vaults WHERE id = ?",
      ).get(s.vaultId) as {
        verifier: string;
        argon2_ops: number;
        argon2_mem: number;
        auth_hash: string;
        rekey_mode: string | null;
      };
      assertEquals(v.verifier, "new-verifier");
      assertEquals(v.argon2_ops, 3);
      assertEquals(v.argon2_mem, 64 * MIB);
      assertEquals(v.auth_hash, NEW_AUTH_HASH);
      assertEquals(v.rekey_mode, null);
      assertEquals(
        s.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(s.vaultId),
        undefined,
      );

      // Heads: the rewritten row is the head; the old path hash is gone.
      const heads = s.db.prepare(
        "SELECT path_hash FROM file_versions WHERE vault_id = ?",
      ).all(s.vaultId) as Array<{ path_hash: string }>;
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, H("e"));

      // Blob dir swapped: V's dir now holds the staging blob.
      assertEquals(Deno.readTextFileSync(blobPath(s.dataDir, s.vaultId, H("d"))), "rekeyed chunk");
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - cancel leaves V intact",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        let res = await startRekey(port, s.vaultId, s.token, "copy");
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const stagingId =
          (s.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(s.vaultId) as {
            id: string;
          }).id;

        res = await req(port, `/vaults/${s.vaultId}/rekey/blobs/${H("d")}`, {
          method: "PUT",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: new TextEncoder().encode("staged"),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "DELETE",
          token: s.token,
          authKey: AUTH_KEY_HEX,
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(
          s.db.prepare("SELECT id FROM vaults WHERE id = ?").get(stagingId),
          undefined,
          "staging row must be gone",
        );
        assertThrows(() => Deno.statSync(`${s.dataDir}/blobs/${stagingId}`), Deno.errors.NotFound);
      });

      // V untouched: original row, original params, mode cleared.
      const v = s.db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem, rekey_mode FROM vaults WHERE id = ?",
      ).get(s.vaultId) as {
        verifier: string;
        argon2_ops: number;
        argon2_mem: number;
        rekey_mode: string | null;
      };
      assertEquals(v.verifier, "old-verifier");
      assertEquals(v.argon2_ops, 1);
      assertEquals(v.argon2_mem, 2);
      assertEquals(v.rekey_mode, null);
      const heads = s.db.prepare("SELECT path_hash FROM file_versions WHERE vault_id = ?").all(
        s.vaultId,
      ) as Array<{ path_hash: string }>;
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, H("b"));
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - replace: start → overwrite blob → rows → switch sets params and clears mode",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        let res = await startRekey(port, s.vaultId, s.token, "replace");
        assertEquals(res.status, 200);
        await res.body?.cancel();

        // Blob overwrites in V's own dir.
        const blob = new TextEncoder().encode("replaced chunk");
        res = await req(port, `/vaults/${s.vaultId}/rekey/blobs/${H("d")}`, {
          method: "PUT",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: blob,
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        assertEquals(
          Deno.readTextFileSync(blobPath(s.dataDir, s.vaultId, H("d"))),
          "replaced chunk",
        );

        // Row rewritten in place.
        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();

        // Cancel refused for replace.
        res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "DELETE",
          token: s.token,
          authKey: AUTH_KEY_HEX,
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: {
            verifier: "new-verifier",
            argon2_ops: 5,
            argon2_mem: 128 * MIB,
            auth_hash: NEW_AUTH_HASH,
          },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });

      const v = s.db.prepare(
        "SELECT verifier, argon2_ops, argon2_mem, auth_hash, rekey_mode FROM vaults WHERE id = ?",
      ).get(s.vaultId) as {
        verifier: string;
        argon2_ops: number;
        argon2_mem: number;
        auth_hash: string;
        rekey_mode: string | null;
      };
      assertEquals(v.verifier, "new-verifier");
      assertEquals(v.argon2_ops, 5);
      assertEquals(v.argon2_mem, 128 * MIB);
      assertEquals(v.auth_hash, NEW_AUTH_HASH);
      assertEquals(v.rekey_mode, null);
      const heads = s.db.prepare(
        "SELECT path_hash, enc_metadata FROM file_versions WHERE vault_id = ?",
      ).all(s.vaultId) as Array<{
        path_hash: string;
        enc_metadata: Uint8Array;
      }>;
      assertEquals(heads.length, 1);
      assertEquals(heads[0].path_hash, H("e"));
      assertEquals(heads[0].enc_metadata, new Uint8Array([7, 7]));
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// #680 - replace mode rewrites every row and blob in place, so the stored_bytes
// counter that described the old ciphertexts goes stale. The copy switch re-measures
// at the end; replace has to as well.
Deno.test({
  name: "rekey - replace: switch re-measures the vault's stored bytes",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      // A counter left over from before the re-key (or drifted): far past the truth,
      // still under the cap so the re-key itself is allowed to write.
      s.db.run("UPDATE vaults SET stored_bytes = ? WHERE id = ?", 5 * GIB, s.vaultId);
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());
        let res = await req(port, `/vaults/${s.vaultId}/rekey/blobs/${H("d")}`, {
          method: "PUT",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: new Uint8Array([1, 2, 3]),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: {
            verifier: "new-verifier",
            argon2_ops: 5,
            argon2_mem: 128 * MIB,
            auth_hash: NEW_AUTH_HASH,
          },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });

      const stored =
        (s.db.prepare("SELECT CAST(stored_bytes AS REAL) AS n FROM vaults WHERE id = ?")
          .get(s.vaultId) as { n: number }).n;
      assert(stored > 0, "the re-measured counter counts the re-keyed tree");
      assert(stored < MIB, `the stale counter must be re-measured, got ${stored}`);
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// #680 - the switch transaction commits before the counter is re-measured, and the
// measure used to run inside the switch's own try: an I/O error while walking the blobs
// answered 409 for a re-key that had already committed, so the client's retry got "no
// rekey in progress" and the run reported a failure on a re-keyed vault.
Deno.test({
  name: "rekey - a failed re-measure does not report a committed switch as 409",
  async fn() {
    for (const mode of ["replace", "copy"]) {
      const s = setup();
      try {
        seedVersion(s.db, s.vaultId, H("b"));
        await withServer(s.dataDir, s.db, async (port) => {
          await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
          const started = await startRekey(port, s.vaultId, s.token, mode);
          assertEquals(started.status, 200);
          await started.body?.cancel();

          breakStoredBytes(s.db);
          const res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
            method: "POST",
            token: s.token,
            authKey: AUTH_KEY_HEX,
            body: {
              verifier: "new-verifier",
              argon2_ops: 5,
              argon2_mem: 128 * MIB,
              auth_hash: NEW_AUTH_HASH,
            },
          });
          assertEquals(res.status, 200, `${mode}: a committed switch must not answer 409`);
          await res.body?.cancel();
        });

        const v = s.db.prepare("SELECT verifier, rekey_mode FROM vaults WHERE id = ?")
          .get(s.vaultId) as { verifier: string; rekey_mode: string | null };
        assertEquals(v.rekey_mode, null, `${mode}: the switch committed`);
        assertEquals(v.verifier, "new-verifier", `${mode}: the new verifier is stored`);
      } finally {
        s.db.close();
        removeTempDir(s.dataDir);
      }
    }
  },
});

// #583 §19: a re-key rewrites rows from an explicit field list: a column missing
// from it silently strips every marker and #582 starts erasing renamed histories.
Deno.test({
  name: "rekey - replace keeps rename_mark on a rewritten row",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        let res = await startRekey(port, s.vaultId, s.token, "replace");
        assertEquals(res.status, 200);
        await res.body?.cancel();

        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e"), RENAME_MARKER),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });

      const row = s.db.prepare(
        "SELECT rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ?",
      ).get(s.vaultId, H("e")) as { rename_mark: number };
      assertEquals(row.rename_mark, RENAME_MARKER);
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

// ── Review fixes (#556) ──────────────────────────────────────────────

Deno.test({
  name: "rekey - switch without start returns 409",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey/switch`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: { verifier: "v", argon2_ops: 1, argon2_mem: 2, auth_hash: NEW_AUTH_HASH },
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - replace rows for a missing version (neither old nor new row) returns 400",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("z"), H("y")),
        });
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - blob PUT past the vault storage budget is refused with 507",
  async fn() {
    const s = setup();
    try {
      s.db.run("UPDATE vaults SET stored_bytes = 5000 WHERE id = ?", s.vaultId);
      Deno.env.set("GEODE_VAULT_MAX_BYTES", "1000");
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey/blobs/${H("a")}`, {
          method: "PUT",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: new Uint8Array(10),
        });
        assertEquals(res.status, 507);
        await res.body?.cancel();
        assertThrows(() => Deno.statSync(blobPath(s.dataDir, s.vaultId, H("a"))));
      });
    } finally {
      Deno.env.delete("GEODE_VAULT_MAX_BYTES");
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - a rows batch over the path_ciphertext cap is refused with 400",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        const body = rowsBody(H("b"), H("e"));
        // Valid base64 just past the cap, so the cap is what refuses it.
        body.versions[0].row.path_ciphertext = "a".repeat(MAX_PATH_CIPHERTEXT_LEN + 4);
        const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body,
        });
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - a rows batch over the enc_metadata cap is refused with 400",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        const body = rowsBody(H("b"), H("e"));
        body.versions[0].row.enc_metadata = "a".repeat(MAX_ENC_METADATA_LEN + 4);
        const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body,
        });
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - a rows batch item without a row is refused with 400",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: { versions: [{ old_path_hash: H("b") }], trash: [] },
        });
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - a rows batch over the trash head caps is refused with 400",
  async fn() {
    const s = setup();
    try {
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        const body = rowsBody(H("b"), H("e"));
        body.trash = [{
          old_path_hash: H("b"),
          row: {
            path_hash: H("b"),
            // A trashed head carries the same payloads, serialized.
            head_json: JSON.stringify({
              version: 1,
              parent: null,
              chunk_hashes: [],
              enc_metadata: "a".repeat(MAX_ENC_METADATA_LEN + 4),
              path_ciphertext: null,
              deleted: 0,
            }),
            deleted_by_device: "dev1",
            trashed_at: 1,
          },
        }];
        const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body,
        });
        assertEquals(res.status, 400);
        await res.body?.cancel();
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - cancel with a missing staging row clears rekey_mode and returns 200",
  async fn() {
    const s = setup();
    try {
      s.db.run("UPDATE vaults SET rekey_mode = 'copy' WHERE id = ?", s.vaultId);
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        const res = await req(port, `/vaults/${s.vaultId}/rekey`, {
          method: "DELETE",
          token: s.token,
          authKey: AUTH_KEY_HEX,
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });
      const mode = s.db.prepare("SELECT rekey_mode FROM vaults WHERE id = ?").get(s.vaultId) as {
        rekey_mode: string | null;
      };
      assertEquals(mode.rekey_mode, null);
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - re-posted rows batch succeeds without duplicates (copy staging)",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "copy").then((r) => r.body?.cancel());
        const stagingId =
          (s.db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(s.vaultId) as {
            id: string;
          }).id;
        for (let i = 0; i < 2; i++) {
          const res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
            method: "POST",
            token: s.token,
            authKey: AUTH_KEY_HEX,
            body: rowsBody(H("b"), H("e")),
          });
          assertEquals(res.status, 200);
          await res.body?.cancel();
        }
        const count = s.db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
          .get(stagingId) as { n: number };
        assertEquals(count.n, 1, "re-posted batch must not duplicate staging rows");
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});

Deno.test({
  name: "rekey - replace rows re-post after a crash resumes (old row gone, new row exists → skip)",
  async fn() {
    const s = setup();
    try {
      seedVersion(s.db, s.vaultId, H("b"));
      await withServer(s.dataDir, s.db, async (port) => {
        await registerAuth(port, s.vaultId, s.token).then((r) => r.body?.cancel());
        await startRekey(port, s.vaultId, s.token, "replace").then((r) => r.body?.cancel());
        // First post rewrites the row in place.
        let res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        // Simulated crash + resume: the same batch is re-posted; the old row is
        // gone and the new row exists, so it must be skipped, not 400.
        res = await req(port, `/vaults/${s.vaultId}/rekey/rows`, {
          method: "POST",
          token: s.token,
          authKey: AUTH_KEY_HEX,
          body: rowsBody(H("b"), H("e")),
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
        const rows = s.db.prepare("SELECT path_hash FROM file_versions WHERE vault_id = ?").all(
          s.vaultId,
        ) as Array<{ path_hash: string }>;
        assertEquals(rows.length, 1);
        assertEquals(rows[0].path_hash, H("e"));
      });
    } finally {
      s.db.close();
      removeTempDir(s.dataDir);
    }
  },
});
