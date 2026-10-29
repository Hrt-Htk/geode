import { blobRoutes } from "../../../server/blob-routes.ts";
import { openDb } from "../../../server/db.ts";
import { assert, assertEquals } from "@std/assert";

const MAX_BLOB_SIZE = 4 * 1024 * 1024;

Deno.test({
  name: "blob-size - oversized stream is rejected without buffering the whole body",
  async fn() {
    const dataDir = Deno.makeTempDirSync();
    const db = openDb(dataDir);
    try {
      const vaultId = crypto.randomUUID();
      const deviceId = crypto.randomUUID();
      const token = "tok-" + crypto.randomUUID();
      db.run(
        "INSERT INTO vaults(id,name,salt,created_at) VALUES(?,?,?,?)",
        vaultId,
        "t",
        new Uint8Array(16),
        Date.now(),
      );
      db.run(
        "INSERT INTO devices(id,vault_id,name,token) VALUES(?,?,?,?)",
        deviceId,
        vaultId,
        "d",
        token,
      );

      // A stream that yields well past the cap; track how many bytes are pulled
      // so we can assert the handler aborts at the cap rather than draining it all.
      let pulled = 0;
      const total = MAX_BLOB_SIZE + 5 * 1024 * 1024;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(64 * 1024);
          pulled += chunk.length;
          controller.enqueue(chunk);
          if (pulled >= total) controller.close();
        },
      });

      const handler = blobRoutes(dataDir, db);
      const req = new Request(`http://localhost/blobs/${"0".repeat(64)}`, {
        method: "POST",
        body: stream,
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await handler(req);
      assertEquals(res.status, 413);
      assert(
        pulled < total,
        `server must abort reading at the cap, but it drained ${pulled} of ${total} bytes`,
      );
    } finally {
      db.close();
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // best-effort
      }
    }
  },
});

Deno.test({
  name: "blob-size - a body with an oversized content-length header is rejected before reading",
  async fn() {
    const dataDir = Deno.makeTempDirSync();
    const db = openDb(dataDir);
    try {
      const vaultId = crypto.randomUUID();
      const deviceId = crypto.randomUUID();
      const token = "tok-" + crypto.randomUUID();
      db.run(
        "INSERT INTO vaults(id,name,salt,created_at) VALUES(?,?,?,?)",
        vaultId,
        "t",
        new Uint8Array(16),
        Date.now(),
      );
      db.run(
        "INSERT INTO devices(id,vault_id,name,token) VALUES(?,?,?,?)",
        deviceId,
        vaultId,
        "d",
        token,
      );

      const handler = blobRoutes(dataDir, db);
      const req = new Request(`http://localhost/blobs/${"0".repeat(64)}`, {
        method: "POST",
        body: new Uint8Array(10),
        headers: {
          Authorization: `Bearer ${token}`,
          "content-length": String(MAX_BLOB_SIZE + 1),
        },
      });

      const res = await handler(req);
      assertEquals(res.status, 413);
    } finally {
      db.close();
      try {
        Deno.removeSync(dataDir, { recursive: true });
      } catch {
        // best-effort
      }
    }
  },
});
