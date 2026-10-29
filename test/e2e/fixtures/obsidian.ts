import { type Browser, chromium, type Page } from "@playwright/test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { isGeodeConsoleError } from "../helpers/console-noise.ts";
import { installPlugin } from "./install.ts";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

type Argon2Params = {
  ops: number;
  mem: number;
  parallel: number;
};

export type GeodeSettings = {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  salt: string;
  verifier: string;
  argon2Params: Argon2Params;
  unlockTimeoutHours: number;
  syncObsidianConfig: boolean;
  debugLogging: boolean;
};

export type ObsidianInstance = {
  app: Browser;
  win: Page;
  vaultDir: string;
  userDataDir: string;
  settings: GeodeSettings;
  consoleErrors: () => string[];
  pluginSettings: (patch: Partial<GeodeSettings>) => Promise<void>;
  eval: <T>(jsExpr: string) => Promise<T>;
  close: () => Promise<void>;
  /** SIGKILL the Electron process mid-operation (no graceful close, no dir cleanup).
   * close() becomes a no-op afterwards; relaunch with vaultDir/userDataDir + prepared. */
  hardKill: () => Promise<void>;
};

// #675: 8 MiB is the server's KDF floor: a join/backfill installs these, so
// they must sit inside the band. ops 1 keeps test derivation fast.
export const TEST_ARGON2_PARAMS: Argon2Params = {
  ops: 1,
  mem: 8 * 1024 * 1024,
  parallel: 1,
};

export const DEFAULT_OBSIDIAN_BIN = process.env.OBSIDIAN_BIN ?? "obsidian";

const ROOT_DIR = process.cwd();
const DEFAULT_PLUGIN_SRC_DIR = path.join(ROOT_DIR, "plugin-dist");

export async function launchObsidian(opts: {
  obsidianBin?: string;
  pluginSrcDir?: string;
  keepStartupModal?: boolean;
  geodeSettings:
    & Partial<GeodeSettings>
    & Pick<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">;
  unlockPassphrase?: string;
  /**
   * Pre-populate the fresh vault with the first `count` .md files (sorted,
   * recursive, .obsidian skipped) copied from `sourceDir` before Obsidian
   * launches, so the reconciler chunks/encrypts/uploads them on startup (#319).
   */
  seedFiles?: { sourceDir: string; count: number };
  /** Reuse an existing vault directory (e.g. relaunch after an offline change). */
  vaultDir?: string;
  /** Reuse an existing user-data directory (vault localStorage survives a relaunch). */
  userDataDir?: string;
  /** Vault is already prepared (plugin installed, data.json written): skip prepareVault so the
   * plugin dir's persisted state (local-files.json, sync-cursor.json) survives a relaunch. */
  prepared?: boolean;
  /** close() leaves the vault directory on disk (userDataDir is still removed). */
  keepVaultDir?: boolean;
  /** close() leaves the user-data directory on disk (vault localStorage survives a relaunch). */
  keepUserDataDir?: boolean;
  /** Rewrite the installed plugin manifest's `version` before Obsidian loads, so the
   * real plugin reports a different version to the server handshake (#529 E2E). */
  pluginVersion?: string;
}): Promise<ObsidianInstance> {
  const obsidianBin = await resolveObsidianBinary(opts.obsidianBin ?? DEFAULT_OBSIDIAN_BIN);
  const pluginSrcDir = opts.pluginSrcDir ?? DEFAULT_PLUGIN_SRC_DIR;
  const vaultDir = opts.vaultDir ?? await mkdtemp(path.join(tmpdir(), "geode-e2e-vault-"));
  const userDataDir = opts.userDataDir ??
    await mkdtemp(path.join(tmpdir(), "geode-e2e-user-data-"));
  const pluginDir = path.join(vaultDir, ".obsidian", "plugins", "geode");
  let settings = mergeSettings(opts.geodeSettings);

  if (!opts.prepared) {
    await prepareVault(vaultDir, pluginDir, pluginSrcDir, settings, opts.pluginVersion);
    if (opts.seedFiles) {
      await seedVaultFiles(vaultDir, opts.seedFiles);
    }
  }
  await writeLauncherState(userDataDir, vaultDir);

  const debugPort = await getFreePort();
  const child = spawn(obsidianBin, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    vaultDir,
  ], {
    cwd: path.dirname(obsidianBin),
    stdio: ["ignore", "pipe", "pipe"],
    // No session bus: otherwise Chromium blocks ~25s on a locked keyring before any requestUrl.
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" },
  });

  try {
    const wsEndpoint = await waitForDevTools(child);
    const app = await chromium.connectOverCDP(wsEndpoint, { timeout: 30_000 });
    const win = await waitForWindow(app);
    const consoleErrors: string[] = [];
    // Only Geode-originated errors are failures; the renderer also reports Obsidian's own (#624).
    win.on("console", (message) => {
      if (message.type() === "error" && isGeodeConsoleError({ text: message.text() })) {
        consoleErrors.push(message.text());
      }
    });
    win.on("pageerror", (error) => {
      if (isGeodeConsoleError({ text: error.message, stack: error.stack })) {
        consoleErrors.push(error.message);
      }
    });

    await win.waitForSelector(".workspace-leaf", { timeout: 60_000 });
    await maybeTrustAuthor(win);
    if (!opts.keepStartupModal) {
      await dismissStartupModal(win);
    }

    const evaluate = async <T>(jsExpr: string): Promise<T> =>
      await win.evaluate(async (source) => {
        const app = (window as { app?: unknown }).app;
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
          ...args: string[]
        ) => (...args: unknown[]) => Promise<unknown>;

        try {
          const expressionFn = new AsyncFunction("app", `return (${source});`);
          return await expressionFn(app);
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }

        const blockFn = new AsyncFunction("app", source);
        return await blockFn(app);
      }, jsExpr);

    if (opts.unlockPassphrase) {
      await win.waitForFunction(
        () => Boolean((window as any).app?.plugins?.plugins?.geode),
        undefined,
        { timeout: 60_000 },
      );
      try {
        await evaluate(
          `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(opts.unlockPassphrase)})`,
        );
      } catch (error) {
        throw new Error(
          `unlockVault failed: ${formatError(error)}; consoleErrors=${
            JSON.stringify(consoleErrors)
          }`,
        );
      }
    }

    let closed = false;

    return {
      app,
      win,
      vaultDir,
      userDataDir,
      settings,
      consoleErrors: () => [...consoleErrors],
      pluginSettings: async (patch) => {
        settings = { ...settings, ...patch };
        await writeJson(path.join(pluginDir, "data.json"), settings);
      },
      eval: evaluate,
      hardKill: async () => {
        if (closed) return;
        closed = true;
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), sleep(5_000)]);
        await app.close().catch(() => {});
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await app.close().catch(() => {});
        child.kill();
        await Promise.race([once(child, "exit"), sleep(5_000)]);
        if (!opts.keepUserDataDir) {
          await rm(userDataDir, { recursive: true, force: true });
        }
        if (!opts.keepVaultDir) {
          await rm(vaultDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    child.kill();
    await Promise.race([once(child, "exit"), sleep(5_000)]);
    await Promise.all([
      rm(vaultDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

async function prepareVault(
  vaultDir: string,
  pluginDir: string,
  pluginSrcDir: string,
  settings: GeodeSettings,
  pluginVersion?: string,
) {
  const obsidianDir = path.join(vaultDir, ".obsidian");
  await mkdir(path.join(obsidianDir, "plugins"), { recursive: true });
  await writeJson(path.join(obsidianDir, "community-plugins.json"), ["geode"]);
  // Trust whoever the built manifest names, so a manifest author change can't
  // silently stop the plugin loading in restricted mode.
  const manifestPath = path.join(pluginSrcDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${path.relative(ROOT_DIR, manifestPath)} missing: run deno task build:plugin`,
    );
  }
  const { author } = JSON.parse(await readFile(manifestPath, "utf8")) as { author: string };
  await writeJson(path.join(obsidianDir, "app.json"), {
    safeMode: false,
    trustedAuthors: [author],
    settingsPopoutWindow: false,
  });
  await installPlugin(pluginSrcDir, pluginDir);
  if (pluginVersion) {
    const manifestPath = path.join(pluginDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
    manifest.version = pluginVersion;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await writeJson(path.join(pluginDir, "data.json"), settings);
}

/** The first `count` .md files under `sourceDir`, as relative paths (sorted, .obsidian skipped),
 * the exact selection `seedVaultFiles` copies, so specs can assert on the seeded set. */
export async function listSeedFiles(sourceDir: string, count: number): Promise<string[]> {
  const sources = (await collectMarkdownFiles(sourceDir)).sort(
    (a, b) => path.relative(sourceDir, a).localeCompare(path.relative(sourceDir, b)),
  );
  if (sources.length < count) {
    throw new Error(
      `seedFiles: only ${sources.length} .md files under ${sourceDir}, requested ${count}`,
    );
  }
  return sources.slice(0, count).map((src) =>
    path.relative(sourceDir, src).split(path.sep).join("/")
  );
}

async function seedVaultFiles(
  vaultDir: string,
  seed: { sourceDir: string; count: number },
): Promise<void> {
  const sourceStat = await stat(seed.sourceDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(
      `seedFiles: sourceDir is not a directory (set GEODE_SEED_VAULT_DIR): "${seed.sourceDir}"`,
    );
  }
  for (const rel of await listSeedFiles(seed.sourceDir, seed.count)) {
    const dest = path.join(vaultDir, ...rel.split("/"));
    await mkdir(path.dirname(dest), { recursive: true });
    const src = path.join(seed.sourceDir, ...rel.split("/"));
    await copyFile(src, dest);
    // Preserve the edit time: the most-recent list and conflict clocks read it, and a
    // cold-synced device must show the same last-known times as the seeder.
    const { mtime } = await stat(src);
    await utimes(dest, mtime, mtime);
  }
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".obsidian") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function writeLauncherState(userDataDir: string, vaultDir: string): Promise<void> {
  await writeJson(path.join(userDataDir, "obsidian.json"), {
    vaults: {
      e2e: {
        path: vaultDir,
        ts: Date.now(),
        open: true,
      },
    },
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeSettings(
  patch:
    & Partial<GeodeSettings>
    & Pick<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">,
): GeodeSettings {
  return {
    serverUrl: patch.serverUrl,
    vaultId: patch.vaultId,
    deviceId: patch.deviceId,
    deviceToken: patch.deviceToken,
    salt: patch.salt,
    verifier: patch.verifier ?? "",
    argon2Params: patch.argon2Params ?? TEST_ARGON2_PARAMS,
    unlockTimeoutHours: patch.unlockTimeoutHours ?? 24,
    syncObsidianConfig: patch.syncObsidianConfig ?? true,
    debugLogging: patch.debugLogging ?? false,
  };
}

async function resolveObsidianBinary(preferredPath: string): Promise<string> {
  const installDir = path.dirname(preferredPath);
  const exeName = path.basename(preferredPath);

  try {
    const entries = await readdir(installDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory() && /^app-\d/.test(entry.name))
      .map((entry) => path.join(installDir, entry.name, exeName))
      .sort((a, b) => compareVersionedDirs(a, b));

    if (candidates.length > 0) {
      return candidates[candidates.length - 1];
    }
  } catch {
    // Fall back to the configured path when the install layout is not inspectable.
  }

  return preferredPath;
}

function compareVersionedDirs(left: string, right: string): number {
  const leftDir = path.basename(path.dirname(left)).replace(/^app-/, "");
  const rightDir = path.basename(path.dirname(right)).replace(/^app-/, "");
  return leftDir.localeCompare(rightDir, undefined, { numeric: true, sensitivity: "base" });
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
    throw new Error("failed to allocate a remote debugging port");
  }
  return port;
}

async function waitForDevTools(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 60_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for Obsidian DevTools endpoint"));
    }, timeoutMs);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      fn();
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        finish(() => resolve(match[1]));
      }
    };
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`Obsidian exited before CDP was ready (code ${code})`)));
    };

    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function waitForWindow(browser: Browser, timeoutMs = 60_000): Promise<Page> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length > 0) {
      return pages[pages.length - 1];
    }
    await sleep(250);
  }
  throw new Error("timed out waiting for an Obsidian window");
}

async function maybeTrustAuthor(win: Page): Promise<void> {
  const trustButton = win.getByRole("button", { name: "Trust author and enable plugins" });
  if (await trustButton.isVisible().catch(() => false)) {
    await trustButton.click();
    await trustButton.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  }
}

async function dismissStartupModal(win: Page): Promise<void> {
  const modal = win.locator(".modal-container");
  // The unlock modal opens after an async key-cache lookup and ignores Escape until fully open.
  await modal.first().waitFor({ timeout: 10_000 }).catch(() => {});
  for (let i = 0; i < 20 && (await modal.count()) > 0; i++) {
    await win.keyboard.press("Escape").catch(() => {});
    await sleep(250);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
