import { httpBase } from "./scheme.ts";
export { httpBase };
import { retryBusy } from "./retry.ts";
import { type ServerAddressCheck, serverCheckStatusToKind } from "./server-address.ts";

/** The admin credential for a write that also carries a device token (#675). */
export const ADMIN_TOKEN_HEADER = "x-geode-admin-token";

export type HttpReq = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
};
export type HttpResp = { status: number; text: string };
export type HttpFn = (req: HttpReq) => Promise<HttpResp>;

// Default implementation: browser/Deno fetch (used by tests and as a fallback).
let httpImpl: HttpFn = async ({ url, method, headers, body }) => {
  // slice() copies to an exactly-sized buffer; body.buffer would send the
  // whole backing store of a view.
  const res = await fetch(url, {
    method,
    headers,
    body: body instanceof Uint8Array ? body.slice().buffer : body,
  });
  return { status: res.status, text: await res.text() };
};

export function setHttpImpl(fn: HttpFn): void {
  httpImpl = fn;
}

/** Non-2xx from the plain JSON surface: callers branch on `status`. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Raw platform HTTP (string or binary body, text response): for callers that
 * need custom headers or non-JSON bodies (re-key blob PUT, NDJSON heads). */
export function rawRequest(req: HttpReq): Promise<HttpResp> {
  return httpImpl(req);
}

export async function request(
  url: string,
  method: string,
  token: string | null,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  // #680: the same busy budget refuses these one-shot calls (join, verifier, purge,
  // admin), and a 503 means the body was never read, so a retry has no side effect.
  const res = await retryBusy(() =>
    httpImpl({
      url,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
  if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(res.status, `${method} ${url} failed: ${res.status} ${res.text}`);
  }
  return res.text ? JSON.parse(res.text) : null;
}

export async function createVault(
  serverUrl: string,
  adminToken: string,
  name: string,
): Promise<{ vaultId: string; salt: string }> {
  const base = httpBase(serverUrl);
  const body = (await request(`${base}/vaults`, "POST", adminToken, { name })) as {
    vault_id: string;
    salt: string;
  };
  return { vaultId: body.vault_id, salt: body.salt };
}

export async function getVaultInfo(
  serverUrl: string,
  adminToken: string,
  vaultId: string,
): Promise<
  { salt: string; verifier: string | null; argon2Ops: number | null; argon2Mem: number | null }
> {
  const base = httpBase(serverUrl);
  const body = (await request(`${base}/vaults/${vaultId}/info`, "GET", adminToken)) as {
    salt: string;
    verifier: string | null;
    argon2_ops: number | null;
    argon2_mem: number | null;
  };
  return {
    salt: body.salt,
    verifier: body.verifier,
    argon2Ops: body.argon2_ops,
    argon2Mem: body.argon2_mem,
  };
}

export async function createDevice(
  serverUrl: string,
  adminToken: string,
  vaultId: string,
  deviceName: string,
): Promise<
  {
    deviceId: string;
    token: string;
    salt: string;
    verifier: string | null;
    argon2Ops: number | null;
    argon2Mem: number | null;
  }
> {
  const base = httpBase(serverUrl);
  const body = (await request(
    `${base}/vaults/${vaultId}/devices`,
    "POST",
    adminToken,
    { device_name: deviceName },
  )) as {
    device_id: string;
    token: string;
    salt: string;
    verifier: string | null;
    argon2_ops: number | null;
    argon2_mem: number | null;
  };
  return {
    deviceId: body.device_id,
    token: body.token,
    salt: body.salt,
    verifier: body.verifier,
    argon2Ops: body.argon2_ops,
    argon2Mem: body.argon2_mem,
  };
}

export async function putVerifier(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  verifierB64: string,
  argon2Params?: { ops: number; mem: number },
  adminToken?: string,
): Promise<void> {
  const base = httpBase(serverUrl);
  const body: { verifier: string; argon2_ops?: number; argon2_mem?: number } = {
    verifier: verifierB64,
  };
  if (argon2Params) {
    body.argon2_ops = argon2Params.ops;
    body.argon2_mem = argon2Params.mem;
  }
  // #675: a first (NULL) verifier is admin-gated; `adminToken` is what the
  // server wants in x-geode-admin-token.
  await request(
    `${base}/vaults/${vaultId}/verifier`,
    "PUT",
    deviceToken,
    body,
    adminToken ? { [ADMIN_TOKEN_HEADER]: adminToken } : undefined,
  );
}

export type VaultInfo = {
  id: string;
  name: string;
  device_count: number;
  created_at: number;
  last_seen_at: number;
};
export type DeviceInfo = { id: string; name: string; last_seen_at: number };

export async function listVaults(serverUrl: string, adminToken: string): Promise<VaultInfo[]> {
  const base = httpBase(serverUrl);
  return (await request(`${base}/vaults`, "GET", adminToken)) as VaultInfo[];
}

export async function listDevices(
  serverUrl: string,
  adminToken: string,
  vaultId: string,
): Promise<DeviceInfo[]> {
  const base = httpBase(serverUrl);
  return (await request(`${base}/vaults/${vaultId}/devices`, "GET", adminToken)) as DeviceInfo[];
}

export type DeviceStatus = {
  id: string;
  name: string;
  last_seen_at: number;
  applied_seq: number | null; // null = never reported
};

export type DevicesStatus = {
  head_seq: number;
  devices: DeviceStatus[];
};

// #433: device-token list for the Devices view: per-device applied position +
// the vault head, so a device without the admin token sees its vault's devices.
export async function listDeviceStatus(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<DevicesStatus> {
  const base = httpBase(serverUrl);
  return (await request(
    `${base}/vaults/${vaultId}/devices/status`,
    "GET",
    deviceToken,
  )) as DevicesStatus;
}

// #431: deviceId→name map for the activity log's remote rows; a failed fetch
// returns null so the caller keeps the neutral "Another device" labels.
export async function deviceNameMap(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<Map<string, string> | null> {
  try {
    const status = await listDeviceStatus(serverUrl, vaultId, deviceToken);
    const names = new Map<string, string>();
    for (const d of status.devices) names.set(d.id, d.name);
    return names;
  } catch {
    return null;
  }
}

export async function revokeDevice(
  serverUrl: string,
  adminToken: string,
  vaultId: string,
  deviceId: string,
): Promise<void> {
  const base = httpBase(serverUrl);
  await request(`${base}/vaults/${vaultId}/devices/${deviceId}`, "DELETE", adminToken);
}

/** Rename this device using its own device token (self-only). */
export async function renameDeviceSelf(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  deviceId: string,
  name: string,
): Promise<void> {
  const base = httpBase(serverUrl);
  await request(`${base}/vaults/${vaultId}/devices/${deviceId}/name`, "PUT", deviceToken, { name });
}

/** Rename this vault using this device's own device token (self-only). */
export async function renameVaultSelf(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  name: string,
): Promise<void> {
  const base = httpBase(serverUrl);
  await request(`${base}/vaults/${vaultId}/name`, "PUT", deviceToken, { name });
}

// #424: real check before a new server address is committed: the server
// answers AND this vault exists for this device token. The device-authed trash
// list is the lightest such endpoint (a heads stream would walk the whole vault).
export async function checkServerVault(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<ServerAddressCheck> {
  const base = httpBase(serverUrl);
  try {
    const res = await httpImpl({
      url: `${base}/vaults/${vaultId}/trash`,
      method: "GET",
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    return serverCheckStatusToKind(res.status);
  } catch {
    return "unreachable";
  }
}

/** Revoke this device using its own device token (self-revoke for leave vault). */
export async function revokeDeviceSelf(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
  deviceId: string,
): Promise<void> {
  const base = httpBase(serverUrl);
  await request(`${base}/vaults/${vaultId}/devices/${deviceId}`, "DELETE", deviceToken);
}
