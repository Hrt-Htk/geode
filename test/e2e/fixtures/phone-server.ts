import { spawnSync } from "node:child_process";
import { requireEnv } from "../env.ts";
import { computeAuthKeyHex } from "../helpers/verifier.ts";
import { type E2EServer, type ProvisionedDevice, startServer } from "./server";

const ADB_PATH = process.env.ADB_PATH || "adb";

// Android 16 (targetSdk 36) Local Network Protections block the Obsidian WebView
// from reaching LAN IPs (connections time out); the system shell is exempt.
// Loopback is exempt too, so we `adb reverse` the server port and point the phone
// at 127.0.0.1 instead of the PC's LAN IP. Idempotent; targets ANDROID_SERIAL. (#241)
export function ensureAdbReverse(port: number): void {
  const r = spawnSync(ADB_PATH, ["reverse", `tcp:${port}`, `tcp:${port}`], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  if (r.status !== 0 || r.error) {
    throw new Error(`adb reverse tcp:${port} failed: ${r.stderr?.trim() || r.error?.message}`);
  }
}

export type RemoteServer = Omit<E2EServer, "shutdown" | "restart" | "dataDir"> & {
  /** Present for the local throwaway server (GEODE_PHONE); a true remote server has no local DB. */
  dataDir?: string;
  shutdown: () => Promise<void>;
  restart: () => Promise<void>;
};

/** The local throwaway server's data dir (server-DB assertions need it; a true remote server has none). */
export function requireDataDir(server: RemoteServer): string {
  if (!server.dataDir) throw new Error("requires the local throwaway server (GEODE_PHONE=1)");
  return server.dataDir;
}

export interface RemoteServerOptions {
  url?: string;
  adminToken?: string;
  /** Extra env for the local throwaway server (e.g. GEODE_MIN_PLUGIN_VERSION, #625). */
  env?: Record<string, string>;
}

export async function useRemoteServer(
  opts: RemoteServerOptions = {},
): Promise<RemoteServer> {
  if (process.env.GEODE_PHONE_HOST) {
    // Local throwaway server with REAL shutdown/restart. The phone reaches it over
    // loopback (adb reverse) rather than the LAN IP: see ensureAdbReverse (#241).
    const port = Number(process.env.GEODE_PHONE_SERVER_PORT ?? "8099");
    ensureAdbReverse(port);
    return startServer({ port, advertiseHost: "127.0.0.1", env: opts.env });
  }
  if (opts.env) {
    throw new Error("server env requires the local throwaway server (GEODE_PHONE_HOST=1)");
  }

  const url = opts.url || requireEnv("GEODE_SERVER_URL");
  const adminToken = opts.adminToken || requireEnv("GEODE_ADMIN_TOKEN");

  const vaultResponse = await fetch(`${url}/vaults`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: `phone-test-${Date.now()}` }),
  });
  if (!vaultResponse.ok) {
    throw new Error(
      `create vault failed: ${vaultResponse.status} ${await vaultResponse.text()}`,
    );
  }

  const vaultData = (await vaultResponse.json()) as { vault_id: string; salt: string };
  const vaultId = vaultData.vault_id;
  const salt = vaultData.salt;

  return {
    url,
    vaultId,
    salt,
    mintToken: (label: string) => createDevice(url, adminToken, vaultId, label),
    // #675: same as the local throwaway server: a seeded vault needs its re-key auth
    // hash registered with the admin token, or every re-key run stops at "not set up".
    registerAuthHash: async (deviceToken, passphrase, params) => {
      const authKey = await computeAuthKeyHex(passphrase, salt, params);
      const res = await fetch(`${url}/vaults/${vaultId}/auth`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "x-geode-admin-token": adminToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ auth_key: authKey }),
      });
      if (!res.ok) {
        throw new Error(`registerAuthHash failed: ${res.status} ${await res.text()}`);
      }
    },
    shutdown: async () => {
      // No-op: remote server lifecycle is managed externally.
    },
    restart: async () => {
      // No-op: remote server lifecycle is managed externally.
    },
    stop: async () => {
      try {
        await fetch(`${url}/vaults/${vaultId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${adminToken}` },
        });
      } catch {
        // Best-effort cleanup; ignore failures.
      }
    },
  };
}

async function createDevice(
  url: string,
  adminToken: string,
  vaultId: string,
  label: string,
): Promise<ProvisionedDevice> {
  const response = await fetch(`${url}/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_name: label }),
  });
  if (!response.ok) {
    throw new Error(`create device failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { device_id: string; token: string };
  return { deviceId: data.device_id, token: data.token };
}
