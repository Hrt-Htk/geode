import { readFile } from "node:fs/promises";
import path from "node:path";
import { type E2EServer, startServer } from "./server";
import {
  collectAllFiles,
  launchObsidian,
  type ObsidianInstance,
  TEST_ARGON2_PARAMS,
} from "./obsidian";
import { freeServerPort } from "../server-port";

// #8: the invented vault the docs images are shot on. See `docs/screenshots/README.md`.

export const DEMO_VAULT_DIR = path.resolve(__dirname, "demo-vault");
export const DEMO_VAULT_NAME = "Field notes";
export const DEMO_PASSPHRASE = "demo-vault-passphrase";

// One host and port, so the address in the settings image does not change on a reshoot. Chromium
// maps the name to loopback for the test only (`--host-resolver-rules`); the fixture's own HTTP
// keeps using the real `server.url`.
export const DEMO_SERVER_HOST = "geode.example.com";
const DEMO_SERVER_PORT = 8098;
const DEMO_SERVER_URL = `http://${DEMO_SERVER_HOST}:${DEMO_SERVER_PORT}`;
/** Chromium switches that make `DEMO_SERVER_HOST` resolve to loopback, for a relaunch too. */
export const DEMO_LAUNCH_ARGS = [`--host-resolver-rules=MAP ${DEMO_SERVER_HOST} 127.0.0.1`];

/** A throwaway server on the fixed port, with the demo vault's two devices. */
export async function demoServer(): Promise<{
  server: E2EServer;
  laptop: { deviceId: string; token: string };
  phone: { deviceId: string; token: string };
}> {
  // A killed run can leave its server behind: free it the way global-setup frees the phone port.
  await freeServerPort(DEMO_SERVER_PORT);
  const server = await startServer({ vaultName: DEMO_VAULT_NAME, port: DEMO_SERVER_PORT });
  const [laptop, phone] = await Promise.all([
    server.mintToken("Laptop"),
    server.mintToken("Phone"),
  ]);
  await server.registerAuthHash(laptop.token, DEMO_PASSPHRASE, TEST_ARGON2_PARAMS);
  return { server, laptop, phone };
}

/** A desktop instance of the demo vault, unless `seed: false` (the second device starts empty). */
export async function launchDemo(
  server: { vaultId: string; salt: string },
  device: { deviceId: string; token: string },
  opts: { seed?: boolean; deviceName?: string; vaultDir?: string; keepVaultDir?: boolean } = {},
): Promise<ObsidianInstance> {
  return await launchObsidian({
    geodeSettings: {
      serverUrl: DEMO_SERVER_URL,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      // Named before the first commit, so the activity feed labels the vault's own rows "Laptop".
      deviceName: opts.deviceName ?? "Laptop",
      // Notes only: a config-sync feed is full of .obsidian json rows and reads like noise.
      syncObsidianConfig: false,
    },
    unlockPassphrase: DEMO_PASSPHRASE,
    copyVaultFrom: opts.seed === false ? undefined : DEMO_VAULT_DIR,
    vaultDir: opts.vaultDir,
    keepVaultDir: opts.keepVaultDir,
    extraArgs: DEMO_LAUNCH_ARGS,
  });
}

/** The demo vault's notes as `path` + text, to write into another device's vault (the phone). */
export async function readDemoNotes(): Promise<{ path: string; content: string }[]> {
  const files = (await collectAllFiles(DEMO_VAULT_DIR)).filter((f) => f.endsWith(".md"));
  return await Promise.all(files.map(async (rel) => ({
    path: rel,
    content: await readFile(path.join(DEMO_VAULT_DIR, ...rel.split("/")), "utf8"),
  })));
}
