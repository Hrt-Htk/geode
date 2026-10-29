import { httpBase, request } from "./provisioning-client.ts";

export interface ServerStorage {
  total: number;
  free: number;
  used: number;
  /** Absent on servers that predate #553. */
  vault_used?: number;
}

export async function getServerStorage(
  serverUrl: string,
  vaultId: string,
  deviceToken: string,
): Promise<ServerStorage> {
  const url = `${httpBase(serverUrl)}/vaults/${vaultId}/storage`;
  return (await request(url, "GET", deviceToken)) as ServerStorage;
}
