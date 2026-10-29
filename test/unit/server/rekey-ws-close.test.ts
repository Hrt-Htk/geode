// #560: the server closes every live WebSocket of a vault when a re-key
// session starts and when the switch commits, so connected devices
// reconnect and read the new hello_ack (rekey flag / verifier hash).
import { type Database, openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { getHub } from "../../../server/ws.ts";
import { authHashHex, deriveAuthKey } from "../../../core/crypto.ts";
import type { VaultKeys } from "../../../core/crypto.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { serveOnPortZero } from "../../helpers/port.ts";
import { assert, assertEquals } from "@std/assert";

// Fixed key material so tests can compute the auth secret without argon2.
const KEYS: VaultKeys = {
  content_key: new Uint8Array(32).fill(3),
  mac_key: new Uint8Array(32).fill(4),
  nonce_key: new Uint8Array(32).fill(5),
};
const AUTH_KEY_HEX = Array.from(deriveAuthKey(KEYS)).map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const NEW_AUTH_HASH = authHashHex(new Uint8Array(32).fill(9));
const ADMIN_TOKEN = "test-admin-token";

interface Closed {
  code: number | null;
  reason: string;
}

function fakeWs(): { ws: WebSocket; closed: Closed } {
  const closed: Closed = { code: null, reason: "" };
  const ws = {
    send: () => {},
    close: (code?: number, reason?: string) => {
      closed.code = code ?? null;
      closed.reason = reason ?? "";
    },
    bufferedAmount: 0,
  } as unknown as WebSocket;
  return { ws, closed };
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

function req(
  port: number,
  path: string,
  opts: { method?: string; token?: string; authKey?: string; adminToken?: string; body?: unknown } =
    {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.authKey !== undefined) headers["x-geode-auth-key"] = opts.authKey;
  if (opts.adminToken !== undefined) headers["x-geode-admin-token"] = opts.adminToken;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return fetch(`http://localhost:${port}${path}`, { method: opts.method ?? "GET", headers, body });
}

function setup(): { db: Database; dataDir: string; vaultId: string; token: string } {
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
  return { db, dataDir, vaultId, token };
}

Deno.test({
  name: "rekey - starting a session closes every live WebSocket of the vault",
  async fn() {
    const { db, dataDir, vaultId, token } = setup();
    try {
      const hub = getHub(db, dataDir, vaultId);
      const a = fakeWs();
      const b = fakeWs();
      hub.register(a.ws, "dev1");
      hub.register(b.ws, "dev2");

      await withServer(dataDir, db, async (port) => {
        const auth = await req(port, `/vaults/${vaultId}/auth`, {
          method: "PUT",
          token,
          adminToken: ADMIN_TOKEN,
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(auth.status, 200);
        const res = await req(port, `/vaults/${vaultId}/rekey`, {
          method: "POST",
          token,
          authKey: AUTH_KEY_HEX,
          body: { mode: "replace" },
        });
        assertEquals(res.status, 200);
      });

      for (const [name, c] of [["dev1", a.closed], ["dev2", b.closed]] as const) {
        assert(
          c.reason === "rekeyed",
          `${name} must be closed with reason "rekeyed", got "${c.reason}"`,
        );
        assert(c.code !== null, `${name} must be closed with a code`);
      }
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "rekey - the switch commit closes every live WebSocket of the vault",
  async fn() {
    const { db, dataDir, vaultId, token } = setup();
    try {
      await withServer(dataDir, db, async (port) => {
        const auth = await req(port, `/vaults/${vaultId}/auth`, {
          method: "PUT",
          token,
          adminToken: ADMIN_TOKEN,
          body: { auth_key: AUTH_KEY_HEX },
        });
        assertEquals(auth.status, 200);
        const start = await req(port, `/vaults/${vaultId}/rekey`, {
          method: "POST",
          token,
          authKey: AUTH_KEY_HEX,
          body: { mode: "replace" },
        });
        assertEquals(start.status, 200);

        // A device that (re)connected during the session.
        const hub = getHub(db, dataDir, vaultId);
        const c = fakeWs();
        hub.register(c.ws, "dev1");

        const res = await req(port, `/vaults/${vaultId}/rekey/switch`, {
          method: "POST",
          token,
          authKey: AUTH_KEY_HEX,
          body: {
            verifier: "new-verifier",
            argon2_ops: 3,
            argon2_mem: 64 * 1024 * 1024,
            auth_hash: NEW_AUTH_HASH,
          },
        });
        assertEquals(res.status, 200);
        assert(
          c.closed.reason === "rekeyed",
          `switch must close live sockets with "rekeyed", got "${c.closed.reason}"`,
        );
        assert(c.closed.code !== null, "switch must close with a code");
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
