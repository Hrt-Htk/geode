import { type DeviceInfo, parseBearerHeader, validateAdminToken, validateToken } from "./auth.ts";
import { checkAdminRate, recordAdminFailure, recordAdminSuccess } from "./rate-limit.ts";
import { log } from "./log.ts";
import { rekeyMode } from "./db.ts";
import type { Database } from "@db/sqlite";

export function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// On mobile the plugin fetches from the Capacitor WebView (origin app://obsidian.md), so every
// custom request header must be allowlisted here or the preflight fails and the call surfaces as
// "TypeError: Failed to fetch": the phone only; desktop rides requestUrl, which has no CORS.
const CORS_ALLOWED_HEADERS = "authorization, content-type, x-geode-auth-key, x-geode-admin-token";

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Default cap for a JSON body. Every JSON route carries a name, a 64-char hash or a
// ≤32-entry purge chain; the re-key rows batch is the one exception (rekey-routes.ts).
export const MAX_JSON_BODY = 64 * 1024;

const decoder = new TextDecoder();

// #680: the per-route caps bound ONE body, and `Deno.serve` has no concurrency limit, so
// a device token can keep many 4 MiB blob POSTs in flight at once. Each read reserves its
// route cap here first, which bounds the bytes under read at 64 MiB. Not the process: a
// handler that has finished reading still holds its body while it writes the blob or
// parses the JSON, so the peak is this plus one body per in-flight handler. A read that
// would pass the reservation is 503 rather than queued, and the reservation lasts the
// whole read, so stalled uploads refuse other reads until their connections end.
export const MAX_INFLIGHT_BODY_BYTES = 64 * 1024 * 1024;
let reservedBodyBytes = 0;

function tooLarge(): Response {
  return jsonResp({ error: "body too large" }, 413);
}

// Read the request body, aborting with 413 the moment it passes `maxBytes` so an
// authed client cannot OOM the server by streaming an unbounded body.
export async function readCappedBody(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | Response> {
  const declared = req.headers.get("content-length");
  if (declared && parseInt(declared, 10) > maxBytes) return tooLarge();
  // The cap, not the declared length: a client can under-declare and then stream.
  if (reservedBodyBytes + maxBytes > MAX_INFLIGHT_BODY_BYTES) {
    const busy = jsonResp({ error: "server busy" }, 503);
    // A read frees its slot when it finishes; clients that read headers back off.
    busy.headers.set("retry-after", "1");
    return busy;
  }
  reservedBodyBytes += maxBytes;
  try {
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  } finally {
    reservedBodyBytes -= maxBytes;
  }
}

// Capped JSON reader for every JSON route: 413 past `maxBytes`, 400 on malformed JSON
// (never a throw), and `{}` for an absent body: several routes treat it as optional.
export async function readJson<T>(req: Request, maxBytes = MAX_JSON_BODY): Promise<T | Response> {
  const raw = await readCappedBody(req, maxBytes);
  if (raw instanceof Response) return raw;
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(decoder.decode(raw)) as T;
  } catch {
    return jsonResp({ error: "malformed json" }, 400);
  }
}

// A cursor query param: absent → `fallback`, anything that is not an integer → 400.
// parseInt turns garbage into NaN, and every `seq > NaN` / `version <= NaN` reads as
// "no rows", so a client bug would look like an empty vault (#680 L-10).
export function intParam(url: URL, name: string, fallback: number): number | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : jsonResp({ error: `invalid ${name}` }, 400);
}

// Device-bearer gate shared by every device-authed HTTP route.
// Pass the vault id to also pin the token to that vault (403 on mismatch);
// omit it for token-only routes (blobs, which key storage off the token's own vault).
export function requireDevice(
  db: Database,
  req: Request,
  expectedVaultId?: string,
): DeviceInfo | Response {
  const token = parseBearerHeader(req.headers.get("authorization"));
  if (!token) return jsonResp({ error: "unauthorized" }, 401);
  const info = validateToken(db, token);
  if (!info) return jsonResp({ error: "unauthorized" }, 401);
  if (expectedVaultId !== undefined && info.vault_id !== expectedVaultId) {
    return jsonResp({ error: "vault mismatch" }, 403);
  }
  return info;
}

// Re-key session block (#556): no vault-data write while rekey_mode is set.
// Shared by every mutating device route (blob POST, trash restore/purge).
export function rekeyBlock(db: Database, vaultId: string): Response | null {
  if (rekeyMode(db, vaultId) === null) return null;
  return jsonResp({ error: "rekey_in_progress" }, 409);
}

// Deno.serve's handler info isn't threaded through the route table, so the
// socket peer rides on the Request under this symbol (set in main.ts).
const remoteAddrKey: unique symbol = Symbol("geode.remoteAddr");

export function attachRemoteAddr(req: Request, addr: Deno.Addr): void {
  (req as unknown as Record<PropertyKey, unknown>)[remoteAddrKey] = addr;
}

function isLoopback(addr: Deno.Addr): boolean {
  if (!("hostname" in addr)) return false; // Unix socket peer
  const h = addr.hostname;
  return h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1";
}

// The socket peer is authoritative. X-Forwarded-For is trusted only when the
// peer is loopback (Caddy on the same host): a direct client must not be able
// to rotate a fake IP per request to dodge the admin rate limit (#533).
export function clientIp(req: Request): string {
  const remote = (req as unknown as Record<PropertyKey, unknown>)[remoteAddrKey] as
    | Deno.Addr
    | undefined;
  if (remote && "hostname" in remote && !isLoopback(remote)) return remote.hostname;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").pop()!.trim();
  return remote && "hostname" in remote ? remote.hostname : "unknown";
}

// `header` names the credential channel. Routes that must prove admin *in
// addition* to a device token carry it in a dedicated header, so the
// authorization bearer stays the device token (#675).
export function adminGate(
  req: Request,
  adminToken: string | null,
  header = "authorization",
): Response | null {
  const ip = clientIp(req);
  const rate = checkAdminRate(ip);
  if (!rate.allowed) {
    log.warn("admin rate-limited", { ip, retryAfterSec: rate.retryAfterSec });
    return new Response(JSON.stringify({ error: "too many attempts" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(rate.retryAfterSec) },
    });
  }
  const raw = req.headers.get(header);
  const token = raw === null ? null : header === "authorization" ? parseBearerHeader(raw) : raw;
  if (!token || !validateAdminToken(token, adminToken)) {
    recordAdminFailure(ip);
    log.warn("admin auth failed", { ip });
    return jsonResp({ error: "admin auth required" }, 401);
  }
  recordAdminSuccess(ip);
  return null; // allowed
}

// The admin credential for a write that also carries a device token rides its
// own header: the authorization bearer is the device token (#675).
const ADMIN_TOKEN_HEADER = "x-geode-admin-token";

// The admin proof for a vault-scoped write that keeps its device token (#675).
// A missing header is a plain 403 that records nothing: every unlock re-sends
// these requests, and 5 recorded failures would 429 the IP's admin routes.
export function requireAdminHeader(req: Request, adminToken: string | null): Response | null {
  if (req.headers.get(ADMIN_TOKEN_HEADER) === null) {
    return jsonResp({ error: "admin auth required" }, 403);
  }
  const denied = adminGate(req, adminToken, ADMIN_TOKEN_HEADER);
  // 401 → 403: the bearer is a valid device token, so this is authority, not identity.
  return denied?.status === 401 ? jsonResp({ error: "admin auth required" }, 403) : denied;
}
