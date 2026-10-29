import {
  type GeodeSettings,
  launchObsidian,
  type ObsidianInstance,
  TEST_ARGON2_PARAMS,
} from "./obsidian";
import { type E2EServer, startServer } from "./server";

export type ObsidianPair = {
  A: ObsidianInstance;
  B: ObsidianInstance;
  server: E2EServer;
  stop: () => Promise<void>;
};

export async function launchPair(opts?: {
  settings?: Partial<
    Omit<GeodeSettings, "serverUrl" | "vaultId" | "deviceId" | "deviceToken" | "salt">
  >;
  passphrase?: string;
  /** Server knobs (e.g. GEODE_COMPACT_FLOOR_DAYS=0 to force a compaction fold). */
  serverEnv?: Record<string, string>;
  /** A.close() leaves A's vault directory on disk (for relaunch in the spec). */
  keepVaultA?: boolean;
  /** B.close() leaves B's vault directory on disk (for relaunch in the spec). */
  keepVaultB?: boolean;
}): Promise<ObsidianPair> {
  const server = await startServer({ env: opts?.serverEnv });
  const [deviceA, deviceB] = await Promise.all([
    server.mintToken("device-A"),
    server.mintToken("device-B"),
  ]);
  // #675: the fixture seeds the vault directly, so it must also do what a real
  // create/join does: register the re-key auth hash with the admin token.
  if (opts?.passphrase) {
    await server.registerAuthHash(
      deviceA.token,
      opts.passphrase,
      opts.settings?.argon2Params ?? TEST_ARGON2_PARAMS,
    );
  }

  let A: ObsidianInstance | null = null;
  let B: ObsidianInstance | null = null;

  try {
    A = await launchObsidian({
      geodeSettings: {
        serverUrl: server.url,
        vaultId: server.vaultId,
        deviceId: deviceA.deviceId,
        deviceToken: deviceA.token,
        salt: server.salt,
        ...opts?.settings,
      },
      unlockPassphrase: opts?.passphrase,
      keepVaultDir: opts?.keepVaultA,
    });
    B = await launchObsidian({
      geodeSettings: {
        serverUrl: server.url,
        vaultId: server.vaultId,
        deviceId: deviceB.deviceId,
        deviceToken: deviceB.token,
        salt: server.salt,
        ...opts?.settings,
      },
      unlockPassphrase: opts?.passphrase,
      keepVaultDir: opts?.keepVaultB,
    });

    return {
      A,
      B,
      server,
      stop: async () => {
        await Promise.allSettled([A?.close(), B?.close(), server.stop()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([A?.close(), B?.close(), server.stop()]);
    throw error;
  }
}
