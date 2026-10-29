// #557: thin HTTP for the re-key surface: TOFU auth registration, the
// /rekey session endpoints (x-geode-auth-key), the re-key blob PUT, row
// batches and the switch. JSON rides the platform request helper; the binary
// blob PUT rides rawRequest (requestUrl on desktop, fetch on mobile, #133).
// A registration 403 is a HttpStatusError so the re-key run can explain it.
import {
  ADMIN_TOKEN_HEADER,
  httpBase,
  HttpStatusError,
  rawRequest,
  request,
} from "./provisioning-client.ts";
import { HttpClient } from "../sync/http-client.ts";
import { deriveAuthKey, type VaultKeys } from "../../core/crypto.ts";
import { toHex } from "../../core/hash.ts";
import type { HeadRecord, VersionRecord } from "../../core/protocol.ts";
import type {
  RekeyClient,
  RekeyMode,
  RekeyTrashEntry,
  RekeyTrashItem,
  RekeyVersionItem,
} from "../sync/rekey-run.ts";
import { formatError, log } from "./log.ts";
import { retryBusy } from "./retry.ts";
import type { PluginSettings } from "./settings-types.ts";

const AUTH_KEY_HEADER = "x-geode-auth-key";

async function authedJson(
  base: string,
  vaultId: string,
  deviceToken: string,
  authKeyHex: string,
  path: string,
  method: string,
  body?: unknown,
): Promise<void> {
  // #680: a 503 is the server's busy budget, not a failed re-key. Retry it, or the
  // run aborts with rekey_mode set and the vault stops syncing.
  const res = await retryBusy(() =>
    rawRequest({
      url: `${base}/vaults/${vaultId}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        [AUTH_KEY_HEADER]: authKeyHex,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(
      res.status,
      `rekey ${method} ${path} failed: ${res.status} ${res.text}`,
    );
  }
}

// Trust on first use: register the vault's auth hash after an interactive unlock, create or join.
// Idempotent for the same key; failures are logged, never block. Without `adminToken` a vault whose
// auth_hash was never registered stays unregistered: the server only accepts the first write from
// an admin caller (#675).
export function registerAuthTofu(
  settings: PluginSettings,
  keys: VaultKeys | null,
  adminToken?: string,
): void {
  if (!keys || !settings.serverUrl || !settings.vaultId || !settings.deviceToken) return;
  void putVaultAuth(
    settings.serverUrl,
    settings.vaultId,
    settings.deviceToken,
    toHex(deriveAuthKey(keys)),
    adminToken,
  ).catch((e) => log.warn("TOFU auth registration failed", { error: formatError(e) }));
}

export async function putVaultAuth(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  authKeyHex: string,
  adminToken?: string,
): Promise<void> {
  await request(
    `${httpBase(serverUrl)}/vaults/${vaultId}/auth`,
    "PUT",
    deviceToken,
    { auth_key: authKeyHex },
    adminToken ? { [ADMIN_TOKEN_HEADER]: adminToken } : undefined,
  );
}

// The server caps /versions pages at 100 rows; paginate with up_to.
const VERSION_PAGE = 100;

/** The re-key blob PUT: bearer plus the re-key auth key, retried on a busy 503 (#680). */
async function putRekeyBlob(
  ctx: { base: string; vaultId: string; deviceToken: string; authKeyHex: string },
  hash: string,
  body: Uint8Array,
): Promise<void> {
  const res = await retryBusy(() =>
    rawRequest({
      url: `${ctx.base}/vaults/${ctx.vaultId}/rekey/blobs/${hash}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ctx.deviceToken}`,
        [AUTH_KEY_HEADER]: ctx.authKeyHex,
        "content-type": "application/octet-stream",
      },
      body,
    })
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`rekey blob PUT ${hash} failed: ${res.status}`);
  }
}

export function makeRekeyClient(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  authKeyHex: string,
): RekeyClient {
  const base = httpBase(serverUrl);
  const blobs = new HttpClient(serverUrl, vaultId, deviceToken);
  const get = (path: string) =>
    rawRequest({
      url: `${base}${path}`,
      method: "GET",
      headers: { Authorization: `Bearer ${deviceToken}` },
    });

  return {
    registerAuth: () => putVaultAuth(serverUrl, vaultId, deviceToken, authKeyHex),
    async heads() {
      const res = await get(`/vaults/${vaultId}/heads?after_seq=0`);
      if (res.status !== 200) throw new Error(`heads GET failed: ${res.status}`);
      return res.text
        .trim()
        .split("\n")
        .filter((line) => line)
        .map((line) => JSON.parse(line) as HeadRecord);
    },
    async versionChain(pathHash: string) {
      const all: VersionRecord[] = [];
      let upTo = Infinity;
      for (;;) {
        const qs = Number.isFinite(upTo) ? `?up_to=${upTo}` : "";
        const res = await get(`/vaults/${vaultId}/versions/${pathHash}${qs}`);
        if (res.status !== 200) throw new Error(`versions GET failed: ${res.status}`);
        const page = JSON.parse(res.text) as VersionRecord[];
        all.push(...page);
        if (page.length < VERSION_PAGE) break;
        upTo = page[page.length - 1].version - 1;
      }
      return all;
    },
    async trash() {
      const res = await get(`/vaults/${vaultId}/trash`);
      if (res.status !== 200) throw new Error(`trash GET failed: ${res.status}`);
      const body = JSON.parse(res.text) as { trash?: RekeyTrashEntry[] };
      return (body.trash ?? []).map((t) => ({
        path_hash: t.path_hash,
        trashed_at: t.trashed_at,
        deleted_by_device: t.deleted_by_device,
        head_json: t.head_json,
      }));
    },
    getBlob: (hash) => blobs.getBlob(hash),
    putBlob: (hash, body) => putRekeyBlob({ base, vaultId, deviceToken, authKeyHex }, hash, body),
    status: () => rekeyStatus(base, vaultId, deviceToken, authKeyHex),
    startSession: (mode: RekeyMode) =>
      authedJson(base, vaultId, deviceToken, authKeyHex, "/rekey", "POST", { mode }),
    postRows: (versions: RekeyVersionItem[], trash: RekeyTrashItem[]) =>
      authedJson(base, vaultId, deviceToken, authKeyHex, "/rekey/rows", "POST", {
        versions,
        trash,
      }),
    switch: (payload) =>
      authedJson(base, vaultId, deviceToken, authKeyHex, "/rekey/switch", "POST", payload),
    cancel: () => authedJson(base, vaultId, deviceToken, authKeyHex, "/rekey", "DELETE"),
  };
}

async function rekeyStatus(
  base: string,
  vaultId: string,
  deviceToken: string,
  authKeyHex: string,
): Promise<{ mode: RekeyMode | null }> {
  const res = await rawRequest({
    url: `${base}/vaults/${vaultId}/rekey`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      [AUTH_KEY_HEADER]: authKeyHex,
    },
  });
  if (res.status !== 200) {
    throw new HttpStatusError(res.status, `rekey status failed: ${res.status}`);
  }
  return JSON.parse(res.text) as { mode: RekeyMode | null };
}
