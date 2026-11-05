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

// #35: the wizard and the flows run the typed address through
// normalizeServerInput and then httpBase/wsBase. A scheme the user typed must
// survive that path; a bare host may only default to plain http on a private or
// local address.
const WIZARD_PATH_CASES: Array<[entered: string, http: string, ws: string]> = [
  ["https://203.0.113.5", "https://203.0.113.5", "wss://203.0.113.5"],
  ["203.0.113.5", "https://203.0.113.5", "wss://203.0.113.5"],
  ["https://geode.example.com", "https://geode.example.com", "wss://geode.example.com"],
  ["geode.example.com", "https://geode.example.com", "wss://geode.example.com"],
  ["http://nas.local:8080", "http://nas.local:8080", "ws://nas.local:8080"],
  ["http://192.168.1.5:8080", "http://192.168.1.5:8080", "ws://192.168.1.5:8080"],
  ["192.168.1.5:8080", "http://192.168.1.5:8080", "ws://192.168.1.5:8080"],
  ["100.100.1.1:8080", "http://100.100.1.1:8080", "ws://100.100.1.1:8080"],
  ["localhost:8080", "http://localhost:8080", "ws://localhost:8080"],
  ["wss://x.example.com", "https://x.example.com", "wss://x.example.com"],
  ["ws://localhost:2705", "http://localhost:2705", "ws://localhost:2705"],
];

Deno.test({
  name: "scheme - the wizard path keeps an explicit scheme and defaults a bare host by locality",
  fn() {
    for (const [entered, http, ws] of WIZARD_PATH_CASES) {
      for (const raw of [entered, `${entered}/`, `${entered}///`]) {
        const stored = normalizeServerInput(raw);
        assertEquals(httpBase(stored), http, raw);
        assertEquals(wsBase(stored), ws, raw);
      }
    }
  },
});

Deno.test({
  name: "scheme - an already stored address with no scheme follows the same local rule",
  fn() {
    assertEquals(httpBase("192.168.1.5:8080"), "http://192.168.1.5:8080");
    assertEquals(httpBase("100.100.1.1:8080"), "http://100.100.1.1:8080");
    assertEquals(httpBase("127.0.0.1:2705"), "http://127.0.0.1:2705");
    assertEquals(httpBase("localhost:2705"), "http://localhost:2705");
    assertEquals(httpBase("geode.example.com"), "https://geode.example.com");
    assertEquals(wsBase("geode.example.com"), "wss://geode.example.com");
    assertEquals(httpBase("203.0.113.5"), "https://203.0.113.5");
    assertEquals(httpBase("sync.myhome.net:8443"), "https://sync.myhome.net:8443");
  },
});
