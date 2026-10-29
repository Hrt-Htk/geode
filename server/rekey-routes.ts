// Re-key session HTTP surface (#556): the start/status/blobs/rows/switch/cancel
// session endpoints, each behind the auth gate in rekey-auth.ts. All SQL lives in
// rekey-store.ts; this file is transport only.
import { HASH_RE, MAX_BLOB_SIZE, putBlob } from "./blobs.ts";
import { jsonResp, readCappedBody, readJson } from "./http-helpers.ts";
import { handlePutAuth, HEX64, requireRekeyAuth } from "./rekey-auth.ts";
import { MAX_REKEY_ROWS_BODY, validateRekeyBatch } from "./ws-commit.ts";
import { paramsOutOfBand } from "./kdf-bounds.ts";
import { addVaultBytes, tryMeasureVault, vaultOverBudget } from "./vault-budget.ts";
import { type Database, rekeyMode } from "./db.ts";
import type { TrashedHeadRow } from "./trash-db.ts";
import {
  cancelStaging,
  createStaging,
  decodeVersionRow,
  insertStagingTrash,
  insertStagingVersion,
  replaceTrashRow,
  replaceVersionRow,
  switchToStaging,
  type WireVersionRow,
} from "./rekey-store.ts";
import { closeAllRekeyedIfLive } from "./ws.ts";

function stagingIdFor(db: Database, vaultId: string): string | null {
  return (db.prepare("SELECT id FROM vaults WHERE rekey_of = ?").get(vaultId) as
    | { id: string }
    | null)?.id ?? null;
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleStartRekey(db: Database, vaultId: string, req: Request): Promise<Response> {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  const body = await readJson<{ mode?: unknown }>(req);
  if (body instanceof Response) return body;
  const mode = body?.mode;
  if (mode !== "copy" && mode !== "replace") {
    return jsonResp({ error: "mode must be copy or replace" }, 400);
  }
  if (rekeyMode(db, vaultId) !== null) return jsonResp({ error: "rekey in progress" }, 409);
  if (mode === "copy") {
    try {
      createStaging(db, vaultId);
    } catch (e) {
      return jsonResp({ error: (e as Error).message }, 409);
    }
  }
  db.run("UPDATE vaults SET rekey_mode = ? WHERE id = ?", mode, vaultId);
  // #560: connected devices must see rekey:true at their next handshake and
  // pause instead of retrying refused commits.
  closeAllRekeyedIfLive(vaultId);
  return jsonResp({ mode }, 200);
}

function handleGetRekey(db: Database, vaultId: string, req: Request): Response {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  const mode = rekeyMode(db, vaultId);
  if (mode === null || mode === "replace") return jsonResp({ mode, rows_done: null }, 200);
  const stagingId = stagingIdFor(db, vaultId);
  if (!stagingId) return jsonResp({ mode, rows_done: null }, 200);
  const versions =
    (db.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?").get(stagingId) as {
      n: number;
    }).n;
  const trash =
    (db.prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?").get(stagingId) as {
      n: number;
    }).n;
  return jsonResp({ mode, rows_done: { versions, trash } }, 200);
}

async function handlePutRekeyBlob(
  dataDir: string,
  db: Database,
  vaultId: string,
  hash: string,
  req: Request,
): Promise<Response> {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  if (!HASH_RE.test(hash)) return jsonResp({ error: "malformed hash" }, 400);
  const mode = rekeyMode(db, vaultId);
  if (mode === null) return jsonResp({ error: "no rekey in progress" }, 409);
  const target = mode === "copy" ? stagingIdFor(db, vaultId) : vaultId;
  if (!target) return jsonResp({ error: "no staging vault" }, 409);
  // #679: a re-key writes to the target vault, so the target's budget applies.
  if (vaultOverBudget(db, target)) {
    return jsonResp({ error: "vault storage full" }, 507);
  }
  const body = await readCappedBody(req, MAX_BLOB_SIZE);
  if (body instanceof Response) return body;
  // overwrite: replace mode re-keys in place: same hash, new ciphertext.
  const result = await putBlob(dataDir, target, hash, body, true);
  if (!result.ok) return jsonResp({ error: "bad request" }, 400);
  addVaultBytes(db, target, result.bytesAdded);
  return jsonResp({ ok: true }, 200);
}

type VersionItem = { old_path_hash: string; row: WireVersionRow };
type TrashItem = { old_path_hash: string; row: Omit<TrashedHeadRow, "vault_id"> };

async function handlePostRows(db: Database, vaultId: string, req: Request): Promise<Response> {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  const mode = rekeyMode(db, vaultId);
  if (mode === null) return jsonResp({ error: "no rekey in progress" }, 409);
  const body = await readJson<{ versions?: unknown; trash?: unknown }>(req, MAX_REKEY_ROWS_BODY);
  if (body instanceof Response) return body;
  const invalid = validateRekeyBatch(body?.versions, body?.trash);
  if (invalid) return jsonResp({ error: invalid }, 400);
  const versions = body?.versions as VersionItem[];
  const trash = body?.trash as TrashItem[];
  try {
    if (mode === "copy") {
      const stagingId = stagingIdFor(db, vaultId);
      if (!stagingId) return jsonResp({ error: "no staging vault" }, 409);
      db.transaction(() => {
        for (const item of versions) {
          insertStagingVersion(db, stagingId, decodeVersionRow(item.row));
        }
        for (const item of trash) insertStagingTrash(db, stagingId, item.row);
      })();
    } else {
      db.transaction(() => {
        for (const item of versions) {
          replaceVersionRow(db, vaultId, item.old_path_hash, decodeVersionRow(item.row));
        }
        for (const item of trash) replaceTrashRow(db, vaultId, item.old_path_hash, item.row);
      })();
    }
  } catch (e) {
    return jsonResp({ error: (e as Error).message }, 400);
  }
  return jsonResp({ ok: true }, 200);
}

interface SwitchPayload {
  verifier: string;
  ops: number;
  mem: number;
  authHash: string;
}

function parseSwitchPayload(body: Record<string, unknown> | null): SwitchPayload | null {
  if (!body) return null;
  const { verifier, argon2_ops: ops, argon2_mem: mem, auth_hash: authHash } = body;
  if (
    typeof verifier !== "string" || typeof ops !== "number" || !Number.isInteger(ops) ||
    typeof mem !== "number" || !Number.isInteger(mem) ||
    typeof authHash !== "string" || !HEX64.test(authHash)
  ) {
    return null;
  }
  return { verifier, ops, mem, authHash };
}

async function handleSwitch(
  db: Database,
  dataDir: string,
  vaultId: string,
  req: Request,
): Promise<Response> {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  const mode = rekeyMode(db, vaultId);
  if (mode === null) return jsonResp({ error: "no rekey in progress" }, 409);
  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof Response) return body;
  const payload = parseSwitchPayload(body);
  if (payload === null) return jsonResp({ error: "invalid switch payload" }, 400);
  // requireRekeyAuth resolved this vault: the row exists.
  const stored = db.prepare("SELECT argon2_ops, argon2_mem FROM vaults WHERE id = ?").get(
    vaultId,
  ) as {
    argon2_ops: number | null;
    argon2_mem: number | null;
  };
  if (
    paramsOutOfBand({ ops: stored.argon2_ops, mem: stored.argon2_mem }, payload.ops, payload.mem)
  ) {
    return jsonResp({ error: "argon2 params out of range" }, 400);
  }
  try {
    if (mode === "copy") {
      const stagingId = stagingIdFor(db, vaultId);
      if (!stagingId) return jsonResp({ error: "no staging vault" }, 409);
      // auth_hash + mode clear ride inside the switch transaction: a crash can
      // never leave the vault on the new key with a stuck rekey_mode.
      switchToStaging(db, dataDir, vaultId, stagingId, {
        verifier: payload.verifier,
        argon2_ops: payload.ops,
        argon2_mem: payload.mem,
        authHash: payload.authHash,
      });
    } else {
      db.run(
        "UPDATE vaults SET verifier = ?, argon2_ops = ?, argon2_mem = ?, auth_hash = ?, rekey_mode = NULL WHERE id = ?",
        payload.verifier,
        payload.ops,
        payload.mem,
        payload.authHash,
        vaultId,
      );
      // #680: replace mode rewrote every row and blob in place, so the counter that
      // described the old ciphertexts is stale. The copy switch re-measures too.
      tryMeasureVault(db, dataDir, vaultId);
    }
  } catch (e) {
    return jsonResp({ error: (e as Error).message }, 409);
  }
  // #560: the vault is on new keys now: every connected device must
  // reconnect and read the new verifier hash.
  closeAllRekeyedIfLive(vaultId);
  return jsonResp({ ok: true }, 200);
}

// Cancel: copy only (replace refuses). Idempotent: a missing staging row
// (crashed mid-cancel) just clears the mode.
function handleCancel(db: Database, dataDir: string, vaultId: string, req: Request): Response {
  const auth = requireRekeyAuth(db, req, vaultId);
  if (auth instanceof Response) return auth;
  const mode = rekeyMode(db, vaultId);
  if (mode === null) return jsonResp({ error: "no rekey in progress" }, 409);
  if (mode === "replace") return jsonResp({ error: "cancel not supported for replace" }, 409);
  const stagingId = stagingIdFor(db, vaultId);
  if (stagingId) {
    try {
      cancelStaging(db, dataDir, stagingId);
    } catch (e) {
      return jsonResp({ error: (e as Error).message }, 409);
    }
  }
  db.run("UPDATE vaults SET rekey_mode = NULL WHERE id = ?", vaultId);
  return jsonResp({ ok: true }, 200);
}

// ── Dispatcher (wired from routes.ts) ────────────────────────────────

function notFound(): Promise<Response> {
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function dispatchRekey(
  dataDir: string,
  db: Database,
  vaultId: string,
  req: Request,
  parts: string[],
): Promise<Response> {
  if (parts.length === 3) {
    if (req.method === "POST") return handleStartRekey(db, vaultId, req);
    if (req.method === "GET") return Promise.resolve(handleGetRekey(db, vaultId, req));
    if (req.method === "DELETE") return Promise.resolve(handleCancel(db, dataDir, vaultId, req));
    return notFound();
  }
  const sub = parts[3];
  if (parts.length === 4) {
    if (sub === "rows" && req.method === "POST") return handlePostRows(db, vaultId, req);
    if (sub === "switch" && req.method === "POST") return handleSwitch(db, dataDir, vaultId, req);
    return notFound();
  }
  if (parts.length === 5 && sub === "blobs" && req.method === "PUT") {
    return handlePutRekeyBlob(dataDir, db, vaultId, parts[4], req);
  }
  return notFound();
}

export function rekeyRoutes(
  dataDir: string,
  db: Database,
  adminToken: string | null,
): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[0] !== "vaults") return notFound();
    const vaultId = parts[1];
    if (parts[2] === "auth" && parts.length === 3) {
      return req.method === "PUT" ? handlePutAuth(db, vaultId, req, adminToken) : notFound();
    }
    if (parts[2] !== "rekey") return notFound();
    return dispatchRekey(dataDir, db, vaultId, req, parts);
  };
}
