// #44: the plugin's server update over HTTP. The POST leaves the empty request file the host
// job answers; the GET reports whether that job is installed and what it last wrote. Geode
// gets no Docker access and no new network access: the request is a file in Geode's own data
// folder and the job's state is mounted read-only (docs/architecture/server.md §11).
import type { Database } from "@db/sqlite";
import { adminGate, jsonResp, requireDevice } from "./http-helpers.ts";
import { envPath } from "./env.ts";
import { log } from "./log.ts";

/** The job writes epoch seconds (`date +%s`), so the request is dated the same way. */
function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** A job that has not run for this long is not installed (server.md §11). */
const HEARTBEAT_FRESH_S = 180;

/** The job's state folder: mounted read-only into the container by compose.yaml. */
function statusDir(): string {
  return envPath("GEODE_UPDATE_STATUS_DIR") ?? "/update-status";
}

/** A file the job writes, or null: a missing folder and an unreadable file are both "no". */
async function readTrimmed(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return null;
  }
}

/** `<status> <epoch>`, one of the words server.md §11 lists; anything else is no result. */
async function readResult(dir: string): Promise<{ word: string; epoch: number } | null> {
  const [word, epoch] = ((await readTrimmed(`${dir}/result`)) ?? "").split(/\s+/);
  const at = Number(epoch);
  if (!/^[a-z][a-z-]*$/.test(word ?? "") || !Number.isInteger(at)) return null;
  return { word, epoch: at };
}

async function handleRequest(
  req: Request,
  adminToken: string | null,
  dataDir: string,
): Promise<Response> {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;
  // Dated before the write: the job's result carries a later epoch, so a client can tell a
  // fresh result from the previous run's.
  const epoch = epochNow();
  try {
    await Deno.writeTextFile(`${dataDir}/update-request`, "");
  } catch (e) {
    log.error("cannot leave the update request", { error: String(e) });
    return jsonResp({ error: "cannot write the update request" }, 500);
  }
  return jsonResp({ epoch }, 200);
}

async function handleStatus(db: Database, req: Request): Promise<Response> {
  const auth = requireDevice(db, req);
  if (auth instanceof Response) return auth;
  const dir = statusDir();
  const heartbeat = Number(await readTrimmed(`${dir}/heartbeat`));
  const installed = Number.isInteger(heartbeat) && epochNow() - heartbeat <= HEARTBEAT_FRESH_S;
  return jsonResp({ installed, result: await readResult(dir) }, 200);
}

/** `POST /update` (admin) and `GET /update/status` (device); anything else under /update is 404. */
export function updateRoutes(
  db: Database,
  adminToken: string | null,
  dataDir: string,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    if (req.method === "POST" && parts.length === 1) {
      return await handleRequest(req, adminToken, dataDir);
    }
    if (req.method === "GET" && parts.length === 2 && parts[1] === "status") {
      return await handleStatus(db, req);
    }
    return new Response("not found", { status: 404 });
  };
}
