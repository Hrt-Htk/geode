import { blobExists, getBlob, HASH_RE, MAX_BLOB_SIZE, putBlob } from "./blobs.ts";
import { readCappedBody, rekeyBlock, requireDevice } from "./http-helpers.ts";
import { addVaultBytes, vaultOverBudget } from "./vault-budget.ts";
import { log } from "./log.ts";
import type { Database } from "@db/sqlite";

async function handleHeadBlob(
  dataDir: string,
  db: Database,
  req: Request,
  hash: string,
): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response("malformed hash", { status: 400 });
  }
  const auth = requireDevice(db, req);
  if (auth instanceof Response) return auth;
  const exists = await blobExists(dataDir, auth.vault_id, hash);
  return exists ? new Response(null, { status: 200 }) : new Response(null, { status: 404 });
}

async function handleGetBlob(
  dataDir: string,
  db: Database,
  req: Request,
  hash: string,
): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response("malformed hash", { status: 400 });
  }
  const auth = requireDevice(db, req);
  if (auth instanceof Response) return auth;
  const body = await getBlob(dataDir, auth.vault_id, hash);
  if (body === null) {
    return new Response("not found", { status: 404 });
  }
  return new Response(body.buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

async function handlePostBlob(
  dataDir: string,
  db: Database,
  req: Request,
  hash: string,
): Promise<Response> {
  if (!HASH_RE.test(hash)) {
    return new Response("malformed hash", { status: 400 });
  }
  const auth = requireDevice(db, req);
  if (auth instanceof Response) return auth;
  const blocked = rekeyBlock(db, auth.vault_id);
  if (blocked) return blocked;
  // #679: refused before the body is read, so a refused upload costs nothing.
  if (vaultOverBudget(db, auth.vault_id)) {
    return new Response("vault storage full", { status: 507 });
  }

  const body = await readCappedBody(req, MAX_BLOB_SIZE);
  if (body instanceof Response) return body;

  const result = await putBlob(dataDir, auth.vault_id, hash, body);
  if (!result.ok) return new Response("bad request", { status: 400 });
  addVaultBytes(db, auth.vault_id, result.bytesAdded);

  log.info("blob put", { hash, vault_id: auth.vault_id });
  return new Response(null, { status: 200 });
}

export function blobRoutes(
  dataDir: string,
  db: Database,
): (req: Request) => Promise<Response> {
  return (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts.length === 2 && pathParts[0] === "blobs") {
      const hash = pathParts[1];
      switch (req.method) {
        case "HEAD":
          return handleHeadBlob(dataDir, db, req, hash);
        case "GET":
          return handleGetBlob(dataDir, db, req, hash);
        case "POST":
          return handlePostBlob(dataDir, db, req, hash);
        default:
          return Promise.resolve(new Response("method not allowed", { status: 405 }));
      }
    }

    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}
