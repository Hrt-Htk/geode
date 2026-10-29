import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { computeAuthKeyHex } from "../helpers/verifier.ts";

const ROOT_DIR = process.cwd();
const DEFAULT_DENO_BIN = process.env.DENO_BIN ?? "deno";
const SERVER_ENTRY = path.join(ROOT_DIR, "server", "main.ts");
const DEFAULT_ADMIN_TOKEN = "e2e";

type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

export type ProvisionedDevice = {
  deviceId: string;
  token: string;
};

export type E2EServer = {
  url: string;
  vaultId: string;
  salt: string;
  /** Server data directory (geode.db inside): specs may open it read-only to poll version counts. */
  dataDir: string;
  mintToken: (label: string) => Promise<ProvisionedDevice>;
  /** #675: register the vault's re-key auth hash the way a real create/join does
   * (admin token + the auth key the plugin derives). Fixtures that seed the vault
   * directly must call this or every re-key run stops at "not set up for rekey yet". */
  registerAuthHash: (
    deviceToken: string,
    passphrase: string,
    params: { ops: number; mem: number },
  ) => Promise<void>;
  shutdown: () => Promise<void>;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startServer(opts?: {
  denoBin?: string;
  adminToken?: string;
  timeoutMs?: number;
  port?: number;
  advertiseHost?: string;
  env?: Record<string, string>;
  /** Use an existing data dir (e.g. a small tmpfs mount) instead of a fresh mkdtemp; not removed on stop. */
  dataDir?: string;
}): Promise<E2EServer> {
  const denoBin = opts?.denoBin ?? DEFAULT_DENO_BIN;
  const adminToken = opts?.adminToken ?? DEFAULT_ADMIN_TOKEN;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const ownsDataDir = !opts?.dataDir;
  const dataDir = opts?.dataDir ?? (await mkdtemp(path.join(tmpdir(), "geode-e2e-server-")));
  const port = opts?.port ?? await getFreePort();
  const url = `http://${opts?.advertiseHost ?? "127.0.0.1"}:${port}`;
  let child = spawnServer(denoBin, dataDir, port, adminToken, opts?.env);
  let running = true;

  try {
    await waitForHttpReady(url, timeoutMs, child, port);
    const vault = await createVault(url, adminToken);
    let stopped = false;

    return {
      url,
      vaultId: vault.vaultId,
      salt: vault.salt,
      dataDir,
      mintToken: (label: string) => createDevice(url, adminToken, vault.vaultId, label),
      registerAuthHash: async (deviceToken, passphrase, params) => {
        const authKey = await computeAuthKeyHex(passphrase, vault.salt, params);
        const res = await fetch(`${url}/vaults/${vault.vaultId}/auth`, {
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
        if (stopped || !running) return;
        await stopChild(child);
        running = false;
      },
      restart: async () => {
        if (stopped) {
          throw new Error("cannot restart a stopped server");
        }
        if (running) {
          await stopChild(child);
        }
        child = spawnServer(denoBin, dataDir, port, adminToken, opts?.env);
        running = true;
        await waitForHttpReady(url, timeoutMs, child, port);
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (running) {
          await stopChild(child);
        }
        if (ownsDataDir) {
          await rm(dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await stopChild(child);
    if (ownsDataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
    throw error;
  }
}

function spawnServer(
  denoBin: string,
  dataDir: string,
  port: number,
  adminToken: string,
  extraEnv?: Record<string, string>,
): ServerChild {
  const child = spawn(
    denoBin,
    [
      "run",
      "--allow-all",
      SERVER_ENTRY,
      "--data-dir",
      dataDir,
      "--port",
      String(port),
    ],
    {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      // Env, not a flag: argv is readable in /proc, and the server takes no
      // --admin-token (#680 L-4).
      env: { ...process.env, ...(extraEnv ?? {}), GEODE_ADMIN_TOKEN: adminToken },
    },
  );

  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function stopChild(child: ServerChild): Promise<void> {
  child.kill();
  await Promise.race([
    once(child, "exit"),
    sleep(5_000),
  ]);
}

async function waitForHttpReady(
  url: string,
  timeoutMs: number,
  child: ServerChild,
  port: number,
): Promise<void> {
  // Only trust an HTTP probe once OUR child has printed "geode server started"
  // (emitted right after Deno.serve binds). If the port is already taken by a
  // leaked throwaway server from a killed run, our child exits EADDRINUSE and
  // never prints it: without this marker the probe would hit the foreign
  // server's healthy response, we'd silently attach to it, and shutdown()
  // would become a no-op (#496).
  const startedAt = Date.now();
  let ourServer = false;
  let stdoutBuf = "";
  child.stdout.on("data", (d: Buffer) => {
    stdoutBuf += String(d);
    if (stdoutBuf.includes('"geode server started"')) ourServer = true;
  });
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `geode server exited early with code ${child.exitCode}: port ${port} already in use (leaked e2e server from a killed run?)`,
      );
    }
    if (ourServer) {
      try {
        const response = await fetch(url);
        if (response.status > 0) return;
      } catch {
        // Server bound but not accepting yet: keep polling.
      }
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for Geode server at ${url}`);
}

async function createVault(
  url: string,
  adminToken: string,
): Promise<{ vaultId: string; salt: string }> {
  const response = await fetch(`${url}/vaults`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "e2e-vault" }),
  });
  if (!response.ok) {
    throw new Error(`create vault failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { vault_id: string; salt: string };
  return { vaultId: data.vault_id, salt: data.salt };
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

  const data = await response.json() as { device_id: string; token: string };
  return { deviceId: data.device_id, token: data.token };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  if (!port) {
    throw new Error("failed to allocate a free port");
  }

  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
