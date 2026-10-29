import { openDb } from "../../server/db.ts";
import { blobRoutes } from "../../server/blob-routes.ts";
import { vaultRoutes } from "../../server/routes.ts";
import { log } from "../../server/log.ts";
import { getHub, hubStore } from "../../server/ws.ts";
import { clearTokenCache } from "../../server/auth.ts";
import { resetRateLimits } from "../../server/rate-limit.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../helpers/temp-dir.ts";
import { serveOnPortZero } from "../helpers/port.ts";

const ADMIN_TOKEN = "test-admin-token-12345";

function setupFixtures(
  db: ReturnType<typeof openDb>,
): { vaultId: string; deviceId: string; token: string } {
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "valid-device-token-" + crypto.randomUUID();

  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "test-vault",
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

function makeHandler(
  dataDir: string,
  db: ReturnType<typeof openDb>,
): (req: Request) => Promise<Response> {
  const blobHandler = blobRoutes(dataDir, db);
  const vaultHandler = vaultRoutes(db, ADMIN_TOKEN, dataDir);
  return (req: Request) => blobHandler(req).then((r) => (r.status === 404 ? vaultHandler(req) : r));
}

async function drain(res: Response): Promise<void> {
  if (res.body) {
    try {
      await res.body.cancel();
    } catch {
      // already consumed
    }
  }
}

async function withServer(
  fn: (port: number, fixtures: ReturnType<typeof setupFixtures>) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  const fixtures = setupFixtures(db);
  const handler = makeHandler(dataDir, db);
  const { port, shutdown, finished } = serveOnPortZero(handler);

  try {
    await fn(port, fixtures);
  } finally {
    await shutdown();
    await finished;
    db.close();
    removeTempDir(dataDir);
  }
}

// ── HTTP Auth Tests ───────────────────────────────────────────────────

Deno.test({
  name: "auth - HTTP without Authorization header returns 401",
  async fn() {
    await withServer(async (port, fixtures) => {
      const res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/heads`);
      assertEquals(res.status, 401);
      const json = await res.json();
      assertEquals(json.error, "unauthorized");
    });
  },
});

Deno.test({
  name: "auth - HTTP with valid token for wrong vault returns 403",
  async fn() {
    await withServer(async (port, fixtures) => {
      const res = await fetch(
        `http://localhost:${port}/vaults/${"00000000-0000-0000-0000-000000000000"}/heads`,
        {
          headers: { Authorization: `Bearer ${fixtures.token}` },
        },
      );
      assertEquals(res.status, 403);
      const json = await res.json();
      assertEquals(json.error, "vault mismatch");
    });
  },
});

Deno.test({
  name: "auth - HTTP with valid token for correct vault returns 200",
  async fn() {
    await withServer(async (port, fixtures) => {
      const res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/heads`, {
        headers: { Authorization: `Bearer ${fixtures.token}` },
      });
      assertEquals(res.status, 200);
      await drain(res);
    });
  },
});

// ── WebSocket Auth Tests ──────────────────────────────────────────────

function makeWsHandler(
  dataDir: string,
  db: ReturnType<typeof openDb>,
): (req: Request) => Response {
  return (req: Request) => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2 || parts[0] !== "vaults") {
      return new Response("missing vault_id", { status: 400 });
    }

    const vaultId = parts[1];
    const protocol = req.headers.get("sec-websocket-protocol") ?? "";
    if (!protocol.startsWith("bearer.")) {
      return new Response("bad protocol", { status: 400 });
    }

    const token = protocol.slice(7);
    const deviceInfo = db.prepare(
      "SELECT d.id as device_id, d.vault_id FROM devices d WHERE d.token = ? LIMIT 1",
    ).get(token) as { device_id: string; vault_id: string } | null;

    if (!deviceInfo || deviceInfo.vault_id !== vaultId) {
      // Upgrade then close with 1008
      const { response, socket } = Deno.upgradeWebSocket(req);
      socket.addEventListener("open", () => {
        socket.close(1008, "invalid token");
      });
      return response;
    }

    const { response, socket } = Deno.upgradeWebSocket(req);
    const hub = getHub(db, dataDir, vaultId);
    hub.handleConnection(socket, deviceInfo.device_id).catch((e) => {
      log.warn("hub error", { error: e.message });
    });
    return response;
  };
}

Deno.test({
  name: "auth - WS upgrade with bad token closes with 1008",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    setupFixtures(db);
    const { port, shutdown, finished } = serveOnPortZero(makeWsHandler(dataDir, db));

    try {
      const ws = new WebSocket(
        `ws://localhost:${port}/vaults/test-vault/sync`,
        "bearer.bad-token-12345",
      );

      const closeCode = await new Promise<number>((resolve) => {
        ws.addEventListener("close", (e) => resolve(e.code), { once: true });
        setTimeout(() => resolve(0), 5000);
      });

      assertEquals(closeCode, 1008);
    } finally {
      await shutdown();
      await finished;
      db.close();
      removeTempDir(dataDir);
      hubStore.clear();
    }
  },
});

Deno.test({
  name: "auth - WS upgrade with valid token succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    const fixtures = setupFixtures(db);
    const { port, shutdown, finished } = serveOnPortZero(makeWsHandler(dataDir, db));

    try {
      const ws = new WebSocket(
        `ws://localhost:${port}/vaults/${fixtures.vaultId}/sync`,
        `bearer.${fixtures.token}`,
      );

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", (e) => reject(e), { once: true });
        setTimeout(() => reject(new Error("timeout")), 5000);
      });

      ws.close();
    } finally {
      await shutdown();
      await finished;
      db.close();
      removeTempDir(dataDir);
      hubStore.clear();
    }
  },
});

// ── Admin Auth Tests ──────────────────────────────────────────────────

Deno.test({
  name: "auth - admin token required for POST /vaults",
  async fn() {
    await withServer(async (port) => {
      // No admin token
      let res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "new-vault" }),
      });
      assertEquals(res.status, 401);
      await drain(res);

      // Wrong admin token
      res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ name: "new-vault" }),
      });
      assertEquals(res.status, 401);
      await drain(res);

      // Correct admin token
      res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "new-vault" }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assert(body.vault_id);
      assert(body.salt);
    });
  },
});

Deno.test({
  name: "auth - admin token required for POST /vaults/:id/devices",
  async fn() {
    await withServer(async (port, fixtures) => {
      // No admin token
      let res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/devices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_name: "test" }),
      });
      assertEquals(res.status, 401);
      await drain(res);

      // Correct admin token
      res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/devices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ device_name: "test-device" }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assert(body.device_id);
      assert(body.token);
    });
  },
});

Deno.test({
  name: "auth - constant-time comparison: correct token works, wrong byte fails",
  async fn() {
    await withServer(async (port) => {
      // Correct token
      let res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "v1" }),
      });
      assertEquals(res.status, 201);
      await drain(res);

      // Off-by-one token (same length, one byte different)
      const last = ADMIN_TOKEN.slice(-1);
      const flipped = last === "0" ? "1" : "0";
      const wrongToken = ADMIN_TOKEN.slice(0, -1) + flipped;
      res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${wrongToken}`,
        },
        body: JSON.stringify({ name: "v2" }),
      });
      assertEquals(res.status, 401);
      await drain(res);
    });
  },
});

// ── Admin Rate Limiting ───────────────────────────────────────────────

Deno.test({
  name:
    "auth - admin: 5 wrong tokens lock the ip (429 + Retry-After), correct token works from another ip",
  async fn() {
    resetRateLimits();
    await withServer(async (port) => {
      const blockedIp = "192.0.2.99";
      const otherIp = "192.0.2.100";

      // 5 wrong-token attempts from blockedIp
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://localhost:${port}/vaults`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": blockedIp,
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ name: "v" + i }),
        });
        assertEquals(res.status, 401);
        await drain(res);
      }

      // 6th attempt from same ip → 429 with Retry-After
      let res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": blockedIp,
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "blocked" }),
      });
      assertEquals(res.status, 429);
      const retryAfter = Number(res.headers.get("retry-after"));
      assert(Number.isFinite(retryAfter) && retryAfter > 0);
      const json = await res.json();
      assertEquals(json.error, "too many attempts");

      // Correct token from a DIFFERENT ip still succeeds
      res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": otherIp,
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "other-ip" }),
      });
      assertEquals(res.status, 201);
      await drain(res);
    });
    resetRateLimits();
  },
});

Deno.test({
  name: "auth - admin: correct token resets an ip that had fewer than MAX failures",
  async fn() {
    resetRateLimits();
    await withServer(async (port) => {
      const ip = "192.0.2.120";

      // 2 wrong-token attempts from ip
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`http://localhost:${port}/vaults`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ name: "w" + i }),
        });
        assertEquals(res.status, 401);
        await drain(res);
      }

      // Correct token from same ip resets the count → still allowed
      let res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "reset" }),
      });
      assertEquals(res.status, 201);
      await drain(res);

      // More wrong attempts now count toward a fresh window
      for (let i = 0; i < 5; i++) {
        res = await fetch(`http://localhost:${port}/vaults`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
            Authorization: "Bearer wrong-token",
          },
          body: JSON.stringify({ name: "x" + i }),
        });
        assertEquals(res.status, 401);
        await drain(res);
      }

      // 6th wrong attempt → blocked
      res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "blocked2" }),
      });
      assertEquals(res.status, 429);
      await drain(res);
    });
    resetRateLimits();
  },
});

// ── Token Revocation Test ─────────────────────────────────────────────

Deno.test({
  name: "auth - token revocation: delete from devices → 401 after cache clear",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    const fixtures = setupFixtures(db);
    const handler = makeHandler(dataDir, db);
    const { port, shutdown, finished } = serveOnPortZero(handler);

    try {
      // First request succeeds (populates cache)
      let res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/heads`, {
        headers: { Authorization: `Bearer ${fixtures.token}` },
      });
      assertEquals(res.status, 200);
      await drain(res);

      // Revoke: delete device from DB
      db.run("DELETE FROM devices WHERE id = ?", fixtures.deviceId);

      // Clear the in-memory cache so the next lookup hits the DB
      clearTokenCache();

      // Next request should fail
      res = await fetch(`http://localhost:${port}/vaults/${fixtures.vaultId}/heads`, {
        headers: { Authorization: `Bearer ${fixtures.token}` },
      });
      assertEquals(res.status, 401);
      await drain(res);
    } finally {
      await shutdown();
      await finished;
      db.close();
      removeTempDir(dataDir);
    }
  },
});

// ── Provisioning End-to-End ───────────────────────────────────────────

Deno.test({
  name: "auth - full provisioning flow: create vault → create device → use device token",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    const handler = makeHandler(dataDir, db);
    const { port, shutdown, finished } = serveOnPortZero(handler);

    try {
      // Step 1: Create vault
      let res = await fetch(`http://localhost:${port}/vaults`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ name: "my-vault" }),
      });
      assertEquals(res.status, 201);
      const vault = await res.json();
      assert(vault.vault_id);
      assert(vault.salt);

      // Step 2: Create device
      res = await fetch(`http://localhost:${port}/vaults/${vault.vault_id}/devices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ device_name: "laptop" }),
      });
      assertEquals(res.status, 201);
      const device = await res.json();
      assert(device.device_id);
      assert(device.token);

      // Step 3: Use device token to access vault data
      res = await fetch(`http://localhost:${port}/vaults/${vault.vault_id}/heads`, {
        headers: { Authorization: `Bearer ${device.token}` },
      });
      assertEquals(res.status, 200);
      await drain(res);

      // Step 4: Device token for wrong vault → 403
      res = await fetch(
        `http://localhost:${port}/vaults/${"00000000-0000-0000-0000-000000000000"}/heads`,
        {
          headers: { Authorization: `Bearer ${device.token}` },
        },
      );
      assertEquals(res.status, 403);
      await drain(res);
    } finally {
      await shutdown();
      await finished;
      db.close();
      removeTempDir(dataDir);
    }
  },
});
