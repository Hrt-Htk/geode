import { log } from "./log.ts";
import {
  adminGate,
  clientIp,
  jsonResp,
  readJson,
  requireAdminHeader,
  requireDevice,
} from "./http-helpers.ts";
import { paramsOutOfBand } from "./kdf-bounds.ts";
import { checkAdminRate, recordAdminFailure } from "./rate-limit.ts";
import { parseBearerHeader, validateAdminToken } from "./auth.ts";
import { b64encode } from "../core/protocol.ts";
import type { Database } from "@db/sqlite";

export async function handleCreateVault(
  db: Database,
  req: Request,
  adminToken: string | null,
): Promise<Response> {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;

  const body = await readJson<{ name?: string }>(req);
  if (body instanceof Response) return body;
  if (!body?.name) {
    return new Response(JSON.stringify({ error: "name required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const vaultId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(salt);

  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    body.name,
    salt,
    Date.now(),
  );

  log.info("vault created", { vault_id: vaultId });

  return new Response(JSON.stringify({ vault_id: vaultId, salt: saltB64 }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

export function handleGetVaultInfo(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Response {
  // #560: a device unlocking after a remote re-key only has its device
  // token: accept the admin token OR a device token pinned to this vault.
  const token = parseBearerHeader(req.headers.get("authorization"));
  if (token && validateAdminToken(token, adminToken)) {
    const denied = adminGate(req, adminToken);
    if (denied) return denied;
  } else {
    // #560: a bearer that is neither admin nor a device of this vault is an
    // admin-auth failure: same per-IP rate limit + failure recording as
    // adminGate, so /info can't be hammered for free.
    const ip = clientIp(req);
    const rate = checkAdminRate(ip);
    if (!rate.allowed) {
      return new Response(JSON.stringify({ error: "too many attempts" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(rate.retryAfterSec) },
      });
    }
    const device = requireDevice(db, req, vaultId);
    if (device instanceof Response) {
      if (token) recordAdminFailure(ip);
      return device;
    }
  }

  // Staging vaults (#555) are invisible to admin info too: 404, not discoverable.
  const vault = db.prepare(
    "SELECT salt, verifier, argon2_ops, argon2_mem FROM vaults WHERE id = ? AND rekey_of IS NULL",
  ).get(vaultId) as {
    salt: Uint8Array;
    verifier: string | null;
    argon2_ops: number | null;
    argon2_mem: number | null;
  } | null;
  if (!vault) {
    return new Response(JSON.stringify({ error: "vault not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const saltB64 = b64encode(vault.salt);
  return new Response(
    JSON.stringify({
      salt: saltB64,
      verifier: vault.verifier,
      argon2_ops: vault.argon2_ops,
      argon2_mem: vault.argon2_mem,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function handleCreateDevice(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Promise<Response> {
  const denied = adminGate(req, adminToken);
  if (denied) return denied;

  const body = await readJson<{ device_name?: string }>(req);
  if (body instanceof Response) return body;
  if (!body?.device_name) {
    return new Response(JSON.stringify({ error: "device_name required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const vault = db.prepare(
    "SELECT id, salt, verifier, argon2_ops, argon2_mem, rekey_of FROM vaults WHERE id = ?",
  ).get(vaultId) as {
    id: string;
    salt: Uint8Array;
    verifier: string | null;
    argon2_ops: number | null;
    argon2_mem: number | null;
    rekey_of: string | null;
  } | null;
  // Staging vaults (#555) never get devices: 404 so they are not even discoverable.
  if (!vault || vault.rekey_of !== null) {
    return new Response(JSON.stringify({ error: "vault not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const deviceId = crypto.randomUUID();
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64encode(tokenBytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    body.device_name,
    token,
  );

  log.info("device created", { device_id: deviceId, vault_id: vaultId });

  const saltB64 = b64encode(vault.salt);

  return new Response(
    JSON.stringify({
      device_id: deviceId,
      token,
      salt: saltB64,
      verifier: vault.verifier,
      argon2_ops: vault.argon2_ops,
      argon2_mem: vault.argon2_mem,
    }),
    {
      status: 201,
      headers: { "content-type": "application/json" },
    },
  );
}

// Everything that must refuse the write before it lands: the admin proof a NULL
// verifier needs (#675), the write-once columns, and the KDF band.
function verifierWriteRefusal(
  vault: { verifier: string | null; argon2_ops: number | null; argon2_mem: number | null },
  body: { verifier?: string; argon2_ops?: number; argon2_mem?: number },
  req: Request,
  adminToken: string | null,
): Response | null {
  // #675: write-once cuts both ways, while the verifier is NULL a device token
  // alone must not be able to choose it.
  if (vault.verifier === null) {
    const denied = requireAdminHeader(req, adminToken);
    if (denied) return denied;
  }
  // Write-once: a non-NULL column may only be rewritten with the identical value.
  if (vault.verifier !== null && vault.verifier !== body.verifier) {
    return jsonResp({ error: "verifier already set" }, 409);
  }
  if (body.argon2_ops === undefined || body.argon2_mem === undefined) return null;
  // Re-sending the stored pair is always allowed (a change-passphrase rekey does).
  const moved = (vault.argon2_ops !== null && vault.argon2_ops !== body.argon2_ops) ||
    (vault.argon2_mem !== null && vault.argon2_mem !== body.argon2_mem);
  if (moved) return jsonResp({ error: "argon2 params already set" }, 409);
  if (
    paramsOutOfBand(
      { ops: vault.argon2_ops, mem: vault.argon2_mem },
      body.argon2_ops,
      body.argon2_mem,
    )
  ) {
    return jsonResp({ error: "argon2 params out of range" }, 400);
  }
  return null;
}

export async function handlePutVerifier(
  db: Database,
  vaultId: string,
  req: Request,
  adminToken: string | null,
): Promise<Response> {
  const info = requireDevice(db, req, vaultId);
  if (info instanceof Response) return info;

  const body = await readJson<{ verifier?: string; argon2_ops?: number; argon2_mem?: number }>(req);
  if (body instanceof Response) return body;
  if (!body?.verifier) {
    return jsonResp({ error: "verifier required" }, 400);
  }

  const vault = db.prepare(
    "SELECT verifier, argon2_ops, argon2_mem FROM vaults WHERE id = ?",
  ).get(vaultId) as {
    verifier: string | null;
    argon2_ops: number | null;
    argon2_mem: number | null;
  } | null;
  if (!vault) {
    return jsonResp({ error: "vault not found" }, 404);
  }

  const refused = verifierWriteRefusal(vault, body, req, adminToken);
  if (refused) return refused;

  if (body.argon2_ops !== undefined && body.argon2_mem !== undefined) {
    db.run(
      "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ? WHERE id = ?",
      body.verifier,
      body.argon2_ops,
      body.argon2_mem,
      vaultId,
    );
  } else {
    db.run("UPDATE vaults SET verifier = ? WHERE id = ?", body.verifier, vaultId);
  }

  return jsonResp({ ok: true }, 200);
}
