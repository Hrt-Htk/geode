import { openDb } from "./db.ts";
import { removeStrandedTempFiles } from "./blobs.ts";
import { recoverRekeyBlobs } from "./rekey-store.ts";
import { purgeExpiredTrash } from "./trash-db.ts";
import { TRASH_RETENTION_DAYS } from "./compaction.ts";
import { blobRoutes } from "./blob-routes.ts";
import { measureVault, vaultMaxBytes } from "./vault-budget.ts";
import { vaultRoutes } from "./routes.ts";
import { log } from "./log.ts";
import { getHub } from "./ws.ts";
import { attachRemoteAddr, withCors } from "./http-helpers.ts";
import { parseSubprotocolBearer, touchDeviceLastSeen, validateToken } from "./auth.ts";
import { parseArgs } from "./args.ts";

function badArgs(message: string): never {
  log.error("bad arguments", { error: message });
  Deno.exit(64);
}

async function main(): Promise<void> {
  // The admin token is env only (argv is world-readable in /proc), and an argument
  // this binary does not take is refused rather than skipped: an ignored flag used to
  // start the server with no admin credential at all (#680 L-4).
  const parsed = parseArgs(Deno.args, Deno.env.get("GEODE_ADMIN_TOKEN") || null);
  if (!parsed.ok) badArgs(parsed.message);
  const { dataDir, port, host, adminToken } = parsed.args;

  if (!adminToken) {
    log.warn("no admin token set", {
      hint: "export GEODE_ADMIN_TOKEN: without it no vault or device can be created",
    });
  }

  await Deno.mkdir(dataDir, { recursive: true });

  const db = openDb(dataDir);

  recoverRekeyBlobs(db, dataDir);

  // A crash mid-write strands a `.tmp-*` blob; putBlob's finally cannot run then, and nothing is
  // in flight before the listener exists.
  const stranded = removeStrandedTempFiles(dataDir);
  if (stranded > 0) log.info("removed stranded blob temp files", { count: stranded });

  const purged = purgeExpiredTrash(db, TRASH_RETENTION_DAYS * 24 * 3600);
  log.info("trash auto-purge", { purged, retention_days: TRASH_RETENTION_DAYS });

  // #679: the budget compares against a counter, so it starts from what is on disk,
  // after the purge above dropped the rows. This walks every vault's blobs once, which
  // costs seconds on a large cold vault.
  const vaults = db.prepare("SELECT id FROM vaults").all() as Array<{ id: string }>;
  for (const v of vaults) measureVault(db, dataDir, v.id);
  // Logged because a unit that predates the knob denies it and the cap stays at the default.
  log.info("vault storage budget", { vaults: vaults.length, max_bytes: vaultMaxBytes() });

  const blobHandler = blobRoutes(dataDir, db);
  const vaultHandler = vaultRoutes(db, adminToken, dataDir);

  const httpHandler = (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
    attachRemoteAddr(req, info.remoteAddr);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return Promise.resolve(handleUpgrade(req, db, dataDir));
    }

    if (req.method === "OPTIONS") {
      return Promise.resolve(withCors(new Response(null, { status: 204 })));
    }

    return blobHandler(req)
      .then((r) => (r.status === 404 ? vaultHandler(req) : Promise.resolve(r)))
      .then((r) => withCors(r));
  };

  const server = Deno.serve({ hostname: host, port }, httpHandler);

  log.info("geode server started", { port, dataDir });

  await server.finished;
  db.close();
}

function handleUpgrade(req: Request, db: ReturnType<typeof openDb>, dataDir: string): Response {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 2 || parts[0] !== "vaults") {
    return new Response("missing vault_id", { status: 400 });
  }

  const vaultId = parts[1];
  const protocol = req.headers.get("sec-websocket-protocol") ?? "";
  const token = parseSubprotocolBearer(protocol);

  if (!token) {
    return new Response("bad protocol", { status: 400 });
  }

  const deviceInfo = validateToken(db, token);
  if (!deviceInfo || deviceInfo.vault_id !== vaultId) {
    // Echo the negotiated subprotocol so the browser COMPLETES the handshake, then close 1008
    // (policy). Upgrading without { protocol } omits the Sec-WebSocket-Protocol response header,
    // which browsers surface as a handshake FAILURE rather than a clean close: noisy on a
    // transient rejection the client just retries.
    log.warn("ws auth rejected", {
      vault_id: vaultId,
      reason: deviceInfo ? "vault_mismatch" : "unknown_token",
    });
    const { response, socket } = Deno.upgradeWebSocket(req, { protocol });
    socket.addEventListener("open", () => {
      socket.close(1008, "invalid token");
    });
    return response;
  }

  const { response, socket } = Deno.upgradeWebSocket(req, {
    protocol,
  });

  touchDeviceLastSeen(db, deviceInfo.device_id);
  const hub = getHub(db, dataDir, vaultId);
  hub.handleConnection(socket, deviceInfo.device_id).catch((e) => {
    log.error("ws handler error", { vault_id: vaultId, error: e.message });
  });

  return response;
}

main().catch((e) => {
  log.error("server fatal", { message: e.message });
  Deno.exit(1);
});
