import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { launchObsidian, type ObsidianInstance } from "./obsidian";

// #8: the invented vault the README and `docs/screenshots` images are taken on. A real vault's
// shape (numbered folders, templated notes with frontmatter) and made up content: no note, name
// or place here exists. It is a fixture, never a copy of a personal vault.

export const DEMO_VAULT_DIR = path.resolve(__dirname, "demo-vault");
/** The demo vault's name: what the settings tab and the README images show. */
export const DEMO_VAULT_NAME = "Field notes";
export const DEMO_PASSPHRASE = "demo-vault-passphrase";

/** A desktop instance on `server`, seeded with the demo vault unless `seed: false`. */
export async function launchDemo(
  server: { url: string; vaultId: string; salt: string },
  device: { deviceId: string; token: string },
  opts: { seed?: boolean; deviceName?: string; vaultDir?: string; keepVaultDir?: boolean } = {},
): Promise<ObsidianInstance> {
  return await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      // Named before the first commit, so the activity feed and the history window label the
      // demo vault's own rows "Laptop" instead of "This device".
      deviceName: opts.deviceName ?? "Laptop",
      // Notes only: a config-sync feed is full of .obsidian json rows and reads like noise.
      syncObsidianConfig: false,
    },
    unlockPassphrase: DEMO_PASSPHRASE,
    copyVaultFrom: opts.seed === false ? undefined : DEMO_VAULT_DIR,
    vaultDir: opts.vaultDir,
    keepVaultDir: opts.keepVaultDir,
  });
}

/** The demo vault's notes as `path` + text, to write into another device's vault (the phone). */
export async function readDemoNotes(): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md")) {
        out.push({ path: rel, content: await readFile(path.join(dir, entry.name), "utf8") });
      }
    }
  };
  await walk(DEMO_VAULT_DIR, "");
  return out;
}
