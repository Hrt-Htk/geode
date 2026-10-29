import { blobRoutes } from "../../../server/blob-routes.ts";
import { openDb } from "../../../server/db.ts";
import { assertEquals } from "@std/assert";
import { blake3 } from "@noble/hashes/blake3";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

function hashOf(bytes: Uint8Array): string {
  return Array.from(blake3(bytes) as unknown as number[]).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function setupDevice(
  db: ReturnType<typeof openDb>,
): { vaultId: string; token: string } {
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "test-device-token-" + crypto.randomUUID();

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

  return { vaultId, token };
}

// Use in-process Deno.serve on an OS-assigned port
async function withServer(
  dataDir: string,
  db: ReturnType<typeof openDb>,
  fn: (port: number, token: string) => Promise<void>,
): Promise<void> {
  const handler = blobRoutes(dataDir, db);
  const { port, shutdown, finished } = serveOnPortZero(handler);
  const { token } = setupDevice(db);
  try {
    await fn(port, token);
  } finally {
    await shutdown();
    await finished;
  }
}

Deno.test({
  name: "routes - POST /blobs/:hash with matching body returns 200",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("route test 200");
      const hash = hashOf(body);
      await withServer(dataDir, db, async (port, token) => {
        const res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - POST /blobs/:hash with mismatched body returns 200 (encrypted content)",
  async fn() {
    // Encrypted blobs: the URL hash is the plaintext chunk hash, but the body
    // is encrypted. The server cannot verify the hash, so it stores the blob.
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("route test encrypted");
      const fakeHash = "0".repeat(64);
      await withServer(dataDir, db, async (port, token) => {
        const res = await fetch(`http://localhost:${port}/blobs/${fakeHash}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - POST /blobs/:hash without auth returns 401",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("no auth");
      await withServer(dataDir, db, async (port) => {
        const res = await fetch(`http://localhost:${port}/blobs/${"0".repeat(64)}`, {
          method: "POST",
          body,
        });
        assertEquals(res.status, 401);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - POST /blobs/:hash during a re-key session returns 409, accepted after",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("rekey block");
      await withServer(dataDir, db, async (port, token) => {
        db.run("UPDATE vaults SET rekey_mode = 'copy'");
        let res = await fetch(`http://localhost:${port}/blobs/${"0".repeat(64)}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 409);
        await res.body?.cancel();
        db.run("UPDATE vaults SET rekey_mode = NULL");
        res = await fetch(`http://localhost:${port}/blobs/${"0".repeat(64)}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        await res.body?.cancel();
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - POST /blobs/:hash with 5MB body returns 413",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new Uint8Array(5 * 1024 * 1024);
      await withServer(dataDir, db, async (port, token) => {
        const res = await fetch(`http://localhost:${port}/blobs/${"0".repeat(64)}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 413);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - POST /blobs/<bad> returns 400",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("hello");
      await withServer(dataDir, db, async (port, token) => {
        const res = await fetch(`http://localhost:${port}/blobs/not-a-hash`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 400);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

async function drain(res: Response): Promise<void> {
  if (res.body) {
    await res.body.cancel();
  }
}

Deno.test({
  name: "routes - HEAD /blobs/:hash returns 200/404 correctly",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("head test");
      const hash = hashOf(body);
      await withServer(dataDir, db, async (port, token) => {
        // Before upload: 404
        let res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          method: "HEAD",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 404);
        await drain(res);

        // Upload
        res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        await drain(res);

        // After upload: 200
        res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          method: "HEAD",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        await drain(res);

        // Unknown hash: 404
        res = await fetch(`http://localhost:${port}/blobs/${"f".repeat(64)}`, {
          method: "HEAD",
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 404);
        await drain(res);
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "routes - GET /blobs/:hash returns 200 with bytes / 404",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const body = new TextEncoder().encode("get test content");
      const hash = hashOf(body);
      await withServer(dataDir, db, async (port, token) => {
        // Before upload: 404
        let res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 404);
        await res.body?.cancel();

        // Upload
        const uploadRes = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
        await drain(uploadRes);

        // After upload: 200 with correct content
        res = await fetch(`http://localhost:${port}/blobs/${hash}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 200);
        const retrieved = new Uint8Array(await res.arrayBuffer());
        assertEquals(retrieved, body);

        // Unknown hash: 404
        res = await fetch(`http://localhost:${port}/blobs/${"f".repeat(64)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assertEquals(res.status, 404);
        await res.body?.cancel();
      });
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
