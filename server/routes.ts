import { getHeadsAfter, getVersionChain } from "./db.ts";
import {
  handleCreateDevice,
  handleCreateVault,
  handleGetVaultInfo,
  handlePutVerifier,
} from "./provisioning.ts";
import {
  handleListDevices,
  handleListDeviceStatus,
  handleListVaults,
  handleRenameDevice,
  handleRenameVault,
  handleRevokeDevice,
} from "./admin-vaults.ts";
import {
  handleListTrash,
  handlePurgeAll,
  handlePurgeExpired,
  handlePurgeOne,
  handleRestoreAll,
  handleRestoreOne,
  handleTrashContent,
} from "./trash.ts";
import { b64encode, type HeadRecord } from "../core/protocol.ts";
import { intParam, jsonResp, requireDevice } from "./http-helpers.ts";
import { rekeyRoutes } from "./rekey-routes.ts";
import { fsUsage } from "./fs-usage.ts";
import { vaultBytes } from "./vault-budget.ts";
import { log } from "./log.ts";
import { SERVER_VERSION } from "./version-gate.ts";
import type { Database } from "@db/sqlite";

// ── Vault data routes ────────────────────────────────────────────────

function handleHeads(
  db: Database,
  vaultId: string,
  url: URL,
  req: Request,
): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;

  const afterSeq = intParam(url, "after_seq", -1);
  if (afterSeq instanceof Response) return afterSeq;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      for (const row of getHeadsAfter(db, vaultId, afterSeq)) {
        const line: HeadRecord = {
          path_hash: row.path_hash,
          version: row.version,
          seq: row.seq,
          enc_metadata: b64encode(row.enc_metadata as unknown as Uint8Array),
          chunk_hashes: row.chunk_hashes,
          deleted: row.deleted === 1,
          path_ciphertext: row.path_ciphertext
            ? b64encode(row.path_ciphertext as unknown as Uint8Array)
            : null,
          rename_mark: row.rename_mark,
        };
        await writer.write(encoder.encode(JSON.stringify(line) + "\n"));
      }
    } finally {
      await writer.close();
    }
  })().catch((e) => {
    log.info("heads stream aborted", { vault_id: vaultId, error: e.message });
  });

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function handleVersions(
  db: Database,
  vaultId: string,
  pathHash: string,
  url: URL,
  req: Request,
): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;

  const upTo = intParam(url, "up_to", Infinity);
  if (upTo instanceof Response) return upTo;
  const before = intParam(url, "before", -1);
  if (before instanceof Response) return before;

  const chain = getVersionChain(db, vaultId, pathHash, upTo, before < 0 ? undefined : before).map((
    row,
  ) => ({
    version: row.version,
    parent: row.parent,
    // #557: additive: the re-key row rewrite needs the row's own path hash.
    path_hash: row.path_hash,
    chunk_hashes: JSON.parse(row.chunk_hashes),
    enc_metadata: b64encode(row.enc_metadata as unknown as Uint8Array),
    compacted_range: row.compacted_range,
    device_id: row.device_id,
    path_ciphertext: row.path_ciphertext
      ? b64encode(row.path_ciphertext as unknown as Uint8Array)
      : null,
    // #557: additive: the re-key row rewrite re-posts these fields verbatim.
    seq: row.seq,
    created_at: row.created_at,
    deleted: row.deleted,
    // #583: additive: rename marker/note, same re-key reason.
    rename_mark: row.rename_mark,
    // #687: additive: restored from the trash, so history can label it.
    ...(row.restored === 1 ? { restored: true } : {}),
  }));
  return new Response(JSON.stringify(chain), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function handleStorage(
  db: Database,
  vaultId: string,
  req: Request,
  dataDir: string,
): Response {
  const authResult = requireDevice(db, req, vaultId);
  if (authResult instanceof Response) return authResult;
  try {
    return jsonResp({ ...fsUsage(dataDir), vault_used: vaultBytes(db, vaultId) }, 200);
  } catch (e) {
    log.error("storage statvfs failed", { vault_id: vaultId, error: String(e) });
    return jsonResp({ error: "internal" }, 500);
  }
}

// ── Route table ──────────────────────────────────────────────────────
// Segments use ":name" to capture a single path segment into params.

type RouteHandler = (
  db: Database,
  adminToken: string | null,
  req: Request,
  url: URL,
  params: Record<string, string>,
) => Response | Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function matchRoute(
  route: Route,
  parts: string[],
  method: string,
): Record<string, string> | null {
  if (route.method !== method || route.segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = route.segments[i];
    if (seg.startsWith(":")) params[seg.slice(1)] = parts[i];
    else if (seg !== parts[i]) return null;
  }
  return params;
}

const routes: Route[] = [
  {
    method: "GET",
    segments: ["version"],
    handler: () => jsonResp({ version: SERVER_VERSION }, 200),
  },
  {
    method: "GET",
    segments: ["vaults"],
    handler: (db, adminToken, req) => handleListVaults(db, req, adminToken),
  },
  {
    method: "POST",
    segments: ["vaults"],
    handler: (db, adminToken, req) => handleCreateVault(db, req, adminToken),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "info"],
    handler: (db, adminToken, req, _url, p) => handleGetVaultInfo(db, p.vaultId, req, adminToken),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "devices"],
    handler: (db, adminToken, req, _url, p) => handleListDevices(db, p.vaultId, req, adminToken),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "devices", "status"],
    handler: (db, _adminToken, req, _url, p) => handleListDeviceStatus(db, p.vaultId, req),
  },
  {
    method: "DELETE",
    segments: ["vaults", ":vaultId", "devices", ":deviceId"],
    handler: (db, adminToken, req, _url, p) =>
      handleRevokeDevice(db, p.vaultId, p.deviceId, req, adminToken),
  },
  {
    method: "PUT",
    segments: ["vaults", ":vaultId", "devices", ":deviceId", "name"],
    handler: (db, _adminToken, req, _url, p) => handleRenameDevice(db, p.vaultId, p.deviceId, req),
  },
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "devices"],
    handler: (db, adminToken, req, _url, p) => handleCreateDevice(db, p.vaultId, req, adminToken),
  },
  {
    method: "PUT",
    segments: ["vaults", ":vaultId", "verifier"],
    handler: (db, adminToken, req, _url, p) => handlePutVerifier(db, p.vaultId, req, adminToken),
  },
  {
    method: "PUT",
    segments: ["vaults", ":vaultId", "name"],
    handler: (db, _adminToken, req, _url, p) => handleRenameVault(db, p.vaultId, req),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "heads"],
    handler: (db, _adminToken, req, url, p) => handleHeads(db, p.vaultId, url, req),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "versions", ":pathHash"],
    handler: (db, _adminToken, req, url, p) => handleVersions(db, p.vaultId, p.pathHash, url, req),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "trash"],
    handler: (db, _adminToken, req, _url, p) => handleListTrash(db, p.vaultId, req),
  },
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "trash", "restore-all"],
    handler: (db, _adminToken, req, _url, p) => handleRestoreAll(db, p.vaultId, req),
  },
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "trash", "purge-expired"],
    handler: (db, _adminToken, req, _url, p) => handlePurgeExpired(db, p.vaultId, req),
  },
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "trash", "purge-all"],
    handler: (db, adminToken, req, _url, p) => handlePurgeAll(db, p.vaultId, req, adminToken),
  },
  {
    method: "DELETE",
    segments: ["vaults", ":vaultId", "trash", ":pathHash"],
    handler: (db, adminToken, req, _url, p) =>
      handlePurgeOne(db, p.vaultId, p.pathHash, req, adminToken),
  },
  // #582: the same purge, carrying the file's chain in the body (a DELETE body is
  // not portable across clients). Additive: the DELETE route above still erases what
  // an old client can identify, the trashed name's own generation.
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "trash", ":pathHash", "purge"],
    handler: (db, adminToken, req, _url, p) =>
      handlePurgeOne(db, p.vaultId, p.pathHash, req, adminToken),
  },
  {
    method: "POST",
    segments: ["vaults", ":vaultId", "trash", ":pathHash", "restore"],
    handler: (db, _adminToken, req, _url, p) => handleRestoreOne(db, p.vaultId, p.pathHash, req),
  },
  {
    method: "GET",
    segments: ["vaults", ":vaultId", "trash", ":pathHash", "content"],
    handler: (db, _adminToken, req, _url, p) => handleTrashContent(db, p.vaultId, p.pathHash, req),
  },
];

export function vaultRoutes(
  db: Database,
  adminToken: string | null,
  dataDir: string,
): (req: Request) => Promise<Response> {
  const rekey = rekeyRoutes(dataDir, db, adminToken);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    // Outside the static table: it needs the data dir, which the table can't see.
    if (
      parts.length >= 3 && parts[0] === "vaults" && (parts[2] === "auth" || parts[2] === "rekey")
    ) {
      return rekey(req);
    }
    if (
      req.method === "GET" && parts.length === 3 && parts[0] === "vaults" && parts[2] === "storage"
    ) {
      return handleStorage(db, parts[1], req, dataDir);
    }
    for (const route of routes) {
      const params = matchRoute(route, parts, req.method);
      if (params) return await route.handler(db, adminToken, req, url, params);
    }
    return new Response("not found", { status: 404 });
  };
}
