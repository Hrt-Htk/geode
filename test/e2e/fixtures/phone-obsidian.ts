import { type Browser, chromium, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type GeodeSettings, TEST_ARGON2_PARAMS } from "./obsidian";
import { phoneTestVault } from "../env.ts";
import { assertTestVault } from "../vault-interlock.ts";
import { isGeodeConsoleError } from "../helpers/console-noise.ts";
import { shotPath } from "../helpers/shots";

const DEFAULT_ADB = process.env.ADB_PATH || "adb";

export type PhoneInstance = {
  app: Browser;
  win: Page;
  eval: <T>(jsExpr: string) => Promise<T>;
  consoleErrors: () => Promise<string[]>;
  screenshot: (path?: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  back: () => Promise<void>;
  enter: () => Promise<void>;
  close: () => Promise<void>;
  /** `am force-stop md.obsidian` mid-operation (no graceful close) + drop the CDP connection. */
  forceStop: () => Promise<void>;
  /** force-stop, relaunch via monkey, wait for a fresh DevTools socket, re-attach (no settings rewrite). */
  relaunch: () => Promise<PhoneInstance>;
};

export interface PhoneObsidianOptions {
  serial?: string;
  adbPath?: string;
  cdpPort?: number;
  geodeSettings?: Partial<GeodeSettings>;
}

function adb(adbPath: string, serial: string | undefined, args: string[]): string {
  const cmdArgs = [...serial ? ["-s", serial] : [], ...args];
  const result = spawnSync(adbPath, cmdArgs, { encoding: "utf-8", timeout: 15_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `ADB ${args.join(" ")} failed: ${
        result.stderr?.trim() || result.error?.message || "unknown"
      }`,
    );
  }
  return (result.stdout || "").trim();
}

function findObsidianWebViewSocket(adbPath: string, serial: string | undefined): string {
  const output = adb(adbPath, serial, ["shell", "cat /proc/net/unix"]);
  const sockets = new Set<string>();
  for (const line of output.split("\n")) {
    const m = line.match(/@(webview_devtools_remote_\S+)/);
    if (m) sockets.add(m[1]);
  }

  if (sockets.size === 0) {
    throw new Error(
      "No webview_devtools_remote socket found. Is Obsidian with DevTools enabled running on the phone?",
    );
  }

  /*
   * If there is exactly one webview socket, use it.
   * If multiple exist, prefer one whose name contains `md.obsidian` (the Obsidian package name);
   * otherwise return the first.
   */
  const list = [...sockets];
  const obsidian = list.find((s) => s.includes("md.obsidian"));
  return obsidian ?? list[0];
}

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css", "versions.json"];
let buildPushed = false;

// Parity with the desktop fixture's installPlugin: when GEODE_PHONE_PUSH is set, push the freshly
// built plugin-dist to the device and restart Obsidian, once per run, before attaching.
async function autoImportBuild(adbPath: string, serial: string | undefined): Promise<void> {
  if (buildPushed || !process.env.GEODE_PHONE_PUSH) return;
  const src = path.resolve(__dirname, "..", "..", "..", "plugin-dist");
  const vault = phoneTestVault();
  const dest = `${vault}/.obsidian/plugins/geode`;
  for (const f of PLUGIN_FILES) {
    adb(adbPath, serial, ["push", path.join(src, f), `${dest}/${f}`]);
  }
  adb(adbPath, serial, ["shell", "am", "force-stop", "md.obsidian"]);
  adb(adbPath, serial, [
    "shell",
    "monkey",
    "-p",
    "md.obsidian",
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      findObsidianWebViewSocket(adbPath, serial);
      buildPushed = true;
      return;
    } catch {
      // DevTools socket not up yet: keep waiting
    }
  }
  throw new Error("phone auto-import: Obsidian DevTools socket did not come up after build push");
}

export async function connectPhone(opts: PhoneObsidianOptions = {}): Promise<PhoneInstance> {
  const adbPath = opts.adbPath || DEFAULT_ADB;
  const cdpPort = opts.cdpPort ?? 9222;
  await autoImportBuild(adbPath, opts.serial);
  const socket = findObsidianWebViewSocket(adbPath, opts.serial);

  adb(adbPath, opts.serial, ["forward", `tcp:${cdpPort}`, `localabstract:${socket}`]);

  let app: Browser | null = null;
  let win: Page | undefined;
  try {
    app = await chromium.connectOverCDP(`http://localhost:${cdpPort}`, { timeout: 30_000 });

    // Obsidian replaces the page's execution context during its initial load
    // navigation, so a page grabbed too early yields a dead context whose
    // window.app never appears (#286). Re-query all pages each iteration and
    // evaluate readiness fresh: tolerating detached-context errors: selecting
    // the page where Obsidian (and, when we need it, the geode plugin) is live.
    const needGeode = Boolean(opts.geodeSettings);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 90_000) {
      for (const page of app.contexts().flatMap((context) => context.pages())) {
        const ready = await page
          .evaluate((wantGeode: boolean) => {
            const a = (window as any).app;
            return Boolean(a?.workspace) && (!wantGeode || Boolean(a?.plugins?.plugins?.geode));
          }, needGeode)
          .catch(() => false);
        if (ready) {
          win = page;
          break;
        }
      }
      if (win) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!win) {
      throw new Error(
        needGeode
          ? "timed out waiting for the geode plugin to load on the phone"
          : "timed out waiting for an Obsidian window on phone",
      );
    }
  } catch (error) {
    // A failed attach must not leave the host-port forward behind: the next
    // run's `adb forward tcp:<port>` would fail to allocate (#519).
    await app?.close().catch(() => {});
    try {
      adb(adbPath, opts.serial, ["forward", "--remove", `tcp:${cdpPort}`]);
    } catch {
      // forward already gone
    }
    throw error;
  }

  const consoleErrors: string[] = [];
  // Only Geode-originated errors are failures; the renderer also reports Capacitor's and
  // Obsidian's own (#624).
  win.on("console", (message) => {
    if (message.type() === "error" && isGeodeConsoleError({ text: message.text() })) {
      consoleErrors.push(message.text());
    }
  });

  const forceStop = async (): Promise<void> => {
    await app.close().catch(() => {});
    adb(adbPath, opts.serial, ["shell", "am", "force-stop", "md.obsidian"]);
  };

  const relaunch = async (): Promise<PhoneInstance> => {
    await forceStop();
    adb(adbPath, opts.serial, [
      "shell",
      "monkey",
      "-p",
      "md.obsidian",
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    // Drop the stale port forward (ignore "not found"), then re-attach once a fresh socket is up.
    spawnSync(adbPath, [
      ...(opts.serial ? ["-s", opts.serial] : []),
      "forward",
      "--remove",
      `tcp:${cdpPort}`,
    ], { timeout: 15_000 });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      try {
        findObsidianWebViewSocket(adbPath, opts.serial);
        return await connectPhone({});
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    throw new Error("phone relaunch: Obsidian DevTools socket did not come up after force-stop");
  };
  win.on("pageerror", (error) => {
    if (isGeodeConsoleError({ text: error.message, stack: error.stack })) {
      consoleErrors.push(error.message);
    }
  });

  const evaluate = async <T>(jsExpr: string): Promise<T> =>
    await win.evaluate(async (source: string) => {
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

  if (opts.geodeSettings) {
    // Plugin readiness is already guaranteed by the page-selection loop above.
    if (process.env.GEODE_PHONE_RESET === "1") {
      // Global setup checks the interlock only when GEODE_PHONE_RESET is already set
      // when the run starts; a spec may set it mid-test (gate7), so never delete
      // without checking the open vault here, immediately before the wipe.
      assertTestVault(await win.evaluate(() => (window as any).app.vault.getName()));
      // mimic desktop's fresh-vault-per-test: delete all vault entries except the .obsidian config dir
      await evaluate(`(async () => {
        const root = await app.vault.adapter.list("/");
        for (const f of (root.files || [])) {
          if (!f.startsWith(".obsidian")) await app.vault.adapter.remove(f);
        }
        for (const d of (root.folders || [])) {
          if (d !== ".obsidian" && !d.startsWith(".obsidian")) await app.vault.adapter.rmdir(d, true);
        }
        return true;
      })()`);
    }
    await evaluate(
      `(async () => {
        const s = app.plugins.plugins.geode.settings;
        Object.assign(s, ${
        JSON.stringify({
          verifier: "",
          argon2Params: TEST_ARGON2_PARAMS,
          unlockTimeoutHours: 24,
          debugLogging: false,
          ...opts.geodeSettings,
        })
      });
        ${process.env.GEODE_PHONE_RESET === "1" ? "s.massDeleteHold = null; s.pauseAt = 0;" : ""}
        await app.plugins.plugins.geode.saveSettings();
        const _geodeDir = app.plugins.plugins.geode?.manifest?.dir ?? (app.vault.configDir + "/plugins/geode");
        await app.plugins.disablePlugin("geode");
        ${
        process.env.GEODE_PHONE_RESET === "1"
          ? `for (const _f of ["sync-cursor.json", "local-files.json"]) {
                 try { if (await app.vault.adapter.exists(_geodeDir + "/" + _f)) await app.vault.adapter.remove(_geodeDir + "/" + _f); } catch (_e) {}
               }`
          : ""
      }
        await app.plugins.enablePlugin("geode");
        return true;
      })()`,
    );
    // wait for the freshly-reloaded plugin to be ready again
    await win.waitForFunction(
      () => Boolean((window as any).app?.plugins?.plugins?.geode),
      undefined,
      { timeout: 60_000 },
    );
    // start locked (match desktop default); clears the on-disk key cache so reloads don't auto-unlock
    await evaluate(`(() => { app.plugins.plugins.geode.lockVault(); return true; })()`);
  }

  return {
    app,
    win,
    eval: evaluate,
    consoleErrors: () => Promise.resolve([...consoleErrors]),
    forceStop,
    relaunch,
    screenshot: (destPath?: string) => {
      const outputPath = destPath || shotPath("phone");
      mkdirSync(path.dirname(outputPath), { recursive: true });
      // screencap -p emits a full-resolution PNG (~4MB); spawnSync's default 1MB
      // maxBuffer overflows it → ENOBUFS with empty stderr (#286). Give it room.
      const result = spawnSync(adbPath, [
        ...(opts.serial ? ["-s", opts.serial] : []),
        "exec-out",
        "screencap",
        "-p",
      ], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0) {
        throw new Error(
          `screencap failed: ${result.error?.message ?? result.stderr?.toString()?.trim() ?? ""}`,
        );
      }
      writeFileSync(outputPath, result.stdout as unknown as string, "binary");
      return Promise.resolve();
    },
    type: (text: string) => {
      const adbText = text.replace(/ /g, "%s");
      adb(adbPath, opts.serial, ["shell", "input", "text", adbText]);
      return Promise.resolve();
    },
    back: () => {
      adb(adbPath, opts.serial, ["shell", "input", "keyevent", "4"]);
      return Promise.resolve();
    },
    enter: () => {
      adb(adbPath, opts.serial, ["shell", "input", "keyevent", "66"]);
      return Promise.resolve();
    },
    close: async () => {
      await app.close();
    },
  };
}
