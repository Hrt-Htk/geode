import { openDb } from "../../server/db.ts";
import { blobRoutes } from "../../server/blob-routes.ts";
import { vaultRoutes } from "../../server/routes.ts";
import { createDevice, createVault, httpBase } from "../../plugin/plumbing/provisioning-client.ts";
import { normalizeServerInput, wsBase } from "../../plugin/plumbing/scheme.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../helpers/temp-dir.ts";
import { serveOnPortZero } from "../helpers/port.ts";

const ADMIN_TOKEN = "test-admin-token-12345";

function makeHandler(
  dataDir: string,
  db: ReturnType<typeof openDb>,
): (req: Request) => Promise<Response> {
  const blobHandler = blobRoutes(dataDir, db);
  const vaultHandler = vaultRoutes(db, ADMIN_TOKEN, dataDir);
  return (req: Request) => blobHandler(req).then((r) => (r.status === 404 ? vaultHandler(req) : r));
}

async function withServer(
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  const handler = makeHandler(dataDir, db);
  const { port, shutdown, finished } = serveOnPortZero(handler);

  try {
    await fn(`http://localhost:${port}`);
  } finally {
    await shutdown();
    await finished;
    db.close();
    removeTempDir(dataDir);
  }
}

Deno.test({
  name: "provisioning-client - createVault + createDevice succeed",
  async fn() {
    await withServer(async (base) => {
      const { vaultId, salt } = await createVault(base, ADMIN_TOKEN, "test-vault");
      assert(vaultId);
      assert(salt);

      const { deviceId, token } = await createDevice(base, ADMIN_TOKEN, vaultId, "laptop");
      assert(deviceId);
      assert(token);
    });
  },
});

Deno.test({
  name: "scheme - normalizeServerInput strips schemes and trailing slashes",
  fn() {
    assertEquals(normalizeServerInput("ws://localhost:2705"), "localhost:2705");
    assertEquals(normalizeServerInput("wss://geode.example.com"), "geode.example.com");
    assertEquals(normalizeServerInput("http://localhost:2705"), "localhost:2705");
    assertEquals(normalizeServerInput("https://geode.example.com/"), "geode.example.com");
    assertEquals(normalizeServerInput("localhost:2705"), "localhost:2705");
    assertEquals(normalizeServerInput("geode.example.com///"), "geode.example.com");
    assertEquals(normalizeServerInput("127.0.0.1:2705"), "127.0.0.1:2705");
  },
});

Deno.test({
  name: "scheme - httpBase/wsBase derive scheme from host (local→http, domain→https)",
  fn() {
    // Local hosts → http/ws
    assertEquals(httpBase("localhost:2705"), "http://localhost:2705");
    assertEquals(wsBase("localhost:2705"), "ws://localhost:2705");
    assertEquals(httpBase("127.0.0.1:2705"), "http://127.0.0.1:2705");
    assertEquals(wsBase("127.0.0.1:2705"), "ws://127.0.0.1:2705");
    assertEquals(httpBase("192.168.1.5:2705"), "http://192.168.1.5:2705");

    // Domain hosts → https/wss
    assertEquals(httpBase("geode.example.com"), "https://geode.example.com");
    assertEquals(wsBase("geode.example.com"), "wss://geode.example.com");
    assertEquals(httpBase("sync.myhome.net:8443"), "https://sync.myhome.net:8443");

    // Schemes in input are stripped first (idempotent)
    assertEquals(httpBase("ws://localhost:2705"), "http://localhost:2705");
    assertEquals(httpBase("wss://geode.example.com"), "https://geode.example.com");
    assertEquals(httpBase("http://localhost:2705///"), "http://localhost:2705");

    // An explicit http/https scheme on a non-local host is honored, not
    // re-derived: http://server.local must stay http even though the
    // host heuristic would pick https.
    assertEquals(httpBase("http://server.local:8099"), "http://server.local:8099");
    assertEquals(wsBase("http://server.local:8099"), "ws://server.local:8099");
    assertEquals(httpBase("https://sync.myhome.net:8443"), "https://sync.myhome.net:8443");
    assertEquals(wsBase("https://sync.myhome.net:8443"), "wss://sync.myhome.net:8443");
    assertEquals(wsBase("wss://sync.myhome.net:8443"), "wss://sync.myhome.net:8443");
  },
});
