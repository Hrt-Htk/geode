import type { GeodeSettings } from "./obsidian";
import { launchObsidian, TEST_ARGON2_PARAMS } from "./obsidian";
import type { E2EServer } from "./server";
import { startServer } from "./server";
import { ensureAdbReverse } from "./phone-server";
import type { PhoneObsidianOptions } from "./phone-obsidian";
import { connectPhone } from "./phone-obsidian";
import { DesktopDevice, PhoneDevice, type SyncDevice } from "../helpers/device-abstraction";

export type HybridPair = {
  A: SyncDevice;
  B: SyncDevice;
  server: E2EServer;
  stop: () => Promise<void>;
};

export async function launchHybridPair(opts: {
  passphrase?: string;
  phoneAsA?: boolean;
  settings?: Partial<
    Omit<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">
  >;
  phoneOpts?: PhoneObsidianOptions;
  serverEnv?: Record<string, string>;
  /**
   * Pre-populate the DESKTOP vault with `count` real .md files copied from
   * sourceDir (default $GEODE_SEED_VAULT_DIR) before Obsidian launches; the
   * desktop's reconciler chunks/encrypts/uploads them, and the phone is held
   * back until the push completes so it cold-syncs a real apply backlog (#319).
   * Undefined = unchanged.
   */
  seedFromVault?: { sourceDir?: string; count: number };
} = {}): Promise<HybridPair> {
  // Default: disable .obsidian config sync for hybrid pairs. Pre-existing divergent
  // config (appearance.json, hotkeys.json, commands.json, etc.) on the phone would
  // produce conflicts / push storms that prevent reaching "Geode: synced".
  // Override with settings: { syncObsidianConfig: true } if a spec needs it.
  const defaultSettings = { syncObsidianConfig: false } as Partial<
    Omit<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">
  >;
  // Android 16 blocks the phone WebView from LAN IPs (#241/#286), so when GEODE_PHONE_HOST is set we
  // advertise loopback and adb-reverse the port: as the phone-only path does, instead of the PC's
  // LAN IP: the desktop reaches 127.0.0.1 directly and the phone reaches it over the reverse tunnel,
  // so both instances use the same URL.
  const phonePort = Number(process.env.GEODE_PHONE_SERVER_PORT ?? "8099");
  if (process.env.GEODE_PHONE_HOST) ensureAdbReverse(phonePort);
  const server = await startServer(
    process.env.GEODE_PHONE_HOST
      ? {
        port: phonePort,
        advertiseHost: "127.0.0.1",
        env: opts.serverEnv,
      }
      : { env: opts.serverEnv },
  );
  const [deviceDesktop, devicePhone] = await Promise.all([
    server.mintToken("device-desktop"),
    server.mintToken("device-phone"),
  ]);
  // #675: the fixture seeds the vault directly, so it must also do what a real
  // create/join does: register the re-key auth hash with the admin token.
  if (opts.passphrase) {
    await server.registerAuthHash(
      deviceDesktop.token,
      opts.passphrase,
      opts.settings?.argon2Params ?? TEST_ARGON2_PARAMS,
    );
  }

  let desktop: DesktopDevice | null = null;
  let phone: PhoneDevice | null = null;

  try {
    const seedFiles = opts.seedFromVault
      ? {
        // Global setup (#518) guarantees GEODE_SEED_VAULT_DIR for hybrid runs.
        sourceDir: opts.seedFromVault.sourceDir ?? process.env.GEODE_SEED_VAULT_DIR!,
        count: opts.seedFromVault.count,
      }
      : undefined;

    desktop = new DesktopDevice(
      await launchObsidian({
        geodeSettings: {
          serverUrl: server.url,
          vaultId: server.vaultId,
          deviceId: deviceDesktop.deviceId,
          deviceToken: deviceDesktop.token,
          salt: server.salt,
          ...defaultSettings,
          ...opts.settings,
        },
        unlockPassphrase: opts.passphrase,
        seedFiles,
      }),
    );

    // Hold the phone back until the desktop has pushed the whole seeded
    // backlog, so the phone cold-syncs a complete, real backlog (#319).
    if (seedFiles) {
      await waitForDesktopPush(desktop, seedFiles.count);
    }

    phone = new PhoneDevice(
      await connectPhone({
        ...opts.phoneOpts,
        geodeSettings: {
          serverUrl: server.url,
          vaultId: server.vaultId,
          deviceId: devicePhone.deviceId,
          deviceToken: devicePhone.token,
          salt: server.salt,
          ...defaultSettings,
          ...opts.settings,
        },
      }),
    );

    // connectPhone leaves the vault locked (desktop's launchObsidian unlocks via unlockPassphrase);
    // unlock the phone here so both instances start unlocked, matching launchPair semantics.
    if (opts.passphrase) {
      await phone.eval(
        `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(opts.passphrase)})`,
      );
    }

    const A = opts.phoneAsA ? phone : desktop;
    const B = opts.phoneAsA ? desktop : phone;

    return {
      A,
      B,
      server,
      stop: async () => {
        await Promise.allSettled([
          desktop?.close(),
          phone?.close(),
          server.stop(),
        ]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      desktop?.close(),
      phone?.close(),
      server.stop(),
    ]);
    throw error;
  }
}

/**
 * Polls the desktop until its reconciler has pushed the seeded backlog:
 * at least `count` local-file rows and zero pending ops (eventHandler +
 * syncManager views merged via getPendingCount). Throws on timeout.
 */
async function waitForDesktopPush(desktop: DesktopDevice, count: number): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = "";
  for (;;) {
    const status = await desktop.eval<{ files: number; pending: number; state: string }>(
      `(() => {
        const g = app.plugins.plugins.geode;
        return {
          files: g?.state?.getAllLocalFiles?.().size ?? 0,
          pending: g?.getPendingCount?.() ?? 0,
          state: g?.getTransportState?.() ?? "?",
        };
      })()`,
    );
    if (status.files >= count && status.pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for desktop push: ${
          JSON.stringify(status)
        } (need files>=${count}, pending=0)`,
      );
    }
    const snapshot = JSON.stringify(status);
    if (snapshot !== last) {
      console.log(`[hybrid-pair] desktop push: ${snapshot}`);
      last = snapshot;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
