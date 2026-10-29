import { openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function makeReq(url: string, method: string, body?: unknown, auth?: string): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  if (auth) {
    init.headers = { ...init.headers, authorization: `Bearer ${auth}` };
  }
  return new Request(url, init);
}

async function drain(res: Response): Promise<void> {
  if (res.body) await res.body.cancel();
}

// ── Pairing routes must return 404 (removed in #233) ────────────────────

Deno.test({
  name: "pairing-removed - POST /vaults/:id/pairing returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const handler = vaultRoutes(db, "admin-token", dataDir);
      const req = makeReq("http://localhost/vaults/fake-id/pairing", "POST", null, "some-token");
      const res = await handler(req);
      assertEquals(res.status, 404);
      await drain(res);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "pairing-removed - POST /pair returns 404",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      const handler = vaultRoutes(db, "admin-token", dataDir);
      const req = makeReq("http://localhost/pair", "POST", { code: "AAAAAA" });
      const res = await handler(req);
      assertEquals(res.status, 404);
      await drain(res);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
