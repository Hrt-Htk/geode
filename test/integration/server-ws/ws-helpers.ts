import { openDb } from "../../../server/db.ts";
import { log } from "../../../server/log.ts";
import { getHub, hubStore } from "../../../server/ws.ts";
import { serveOnPortZero } from "../../helpers/port.ts";

export function ensureVaultAndDevices(
  db: ReturnType<typeof openDb>,
  vaultId: string,
  deviceIds: string[],
): void {
  db.run(
    `INSERT OR IGNORE INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)`,
    vaultId,
    "test",
    new Uint8Array(16),
    Date.now(),
  );
  for (const id of deviceIds) {
    db.run(
      `INSERT OR IGNORE INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)`,
      id,
      vaultId,
      "dev-" + id,
      "token-" + id,
    );
  }
}

export function startServer(
  dataDir: string,
  deviceIds: string[],
): { port: number; stop: () => Promise<void>; db: ReturnType<typeof openDb> } {
  const db = openDb(dataDir);
  ensureVaultAndDevices(db, "test-vault", deviceIds);

  const { port, shutdown } = serveOnPortZero((req: Request) => {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return handleUpgrade(req, db, dataDir, url);
    }
    return new Response("ok", { status: 200 });
  });

  return {
    port,
    db,
    stop: async () => {
      await shutdown();
      hubStore.clear();
      db.close();
    },
  };
}

export function handleUpgrade(
  req: Request,
  db: ReturnType<typeof openDb>,
  dataDir: string,
  url: URL,
): Response {
  const vaultId = url.pathname.split("/").filter(Boolean)[1];
  const protocol = req.headers.get("sec-websocket-protocol") ?? "";
  if (!protocol.startsWith("bearer.")) {
    return new Response("bad protocol", { status: 400 });
  }
  const token = protocol.slice(7);
  // Gate 3 stub: accept any non-empty token (real auth = Gate 7)
  if (token.length === 0) {
    return new Response("invalid token", { status: 400 });
  }

  const { response, socket } = Deno.upgradeWebSocket(req, { protocol });

  const hub = getHub(db, dataDir, vaultId!);
  hub.handleConnection(socket, token).catch((e) => {
    log.warn("hub error", { error: e.message });
  });

  return response;
}
