import { launchObsidian, type ObsidianInstance, TEST_ARGON2_PARAMS } from "./obsidian";
import type { E2EServer } from "./server";

// Launch a fresh, UNCONFIGURED Obsidian (blank creds) so the setup wizard auto-opens.
// `server` is accepted for symmetry/typing; creds are intentionally blank because the
// test drives the wizard DOM (including the server URL field). Same Argon2 params on every
// device so the passphrase verifier matches across devices.
export async function launchUnconfigured(
  server: E2EServer,
  opts?: { keepStartupModal?: boolean; pluginSrcDir?: string },
): Promise<ObsidianInstance> {
  void server;
  return await launchObsidian({
    pluginSrcDir: opts?.pluginSrcDir,
    keepStartupModal: opts?.keepStartupModal ?? true,
    geodeSettings: {
      serverUrl: "",
      vaultId: "",
      deviceId: "",
      deviceToken: "",
      salt: "",
      argon2Params: TEST_ARGON2_PARAMS,
    },
  });
}
