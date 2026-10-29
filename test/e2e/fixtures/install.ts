import { cp, rm } from "node:fs/promises";
import path from "node:path";

// Install the built plugin into a vault's plugin directory. Always COPY (never symlink): a symlink
// would route the vault's per-test data.json writes back into the shared build dir (plugin-dist),
// clobbering any real vault that is itself symlinked to plugin-dist. Strip vault-specific runtime
// state that lives in plugin-dist (key cache, settings, StateDB export) so each test vault starts
// clean: otherwise a stale .geode_key_cache.json auto-unlocks the vault and leaked local-files.json
// pollutes reconciliation.
const RUNTIME_STATE_FILES = [
  ".geode_key_cache.json",
  "data.json",
  "local-files.json",
  "sync-cursor.json",
];

export async function installPlugin(pluginSrcDir: string, pluginDir: string): Promise<void> {
  await rm(pluginDir, { recursive: true, force: true });
  await cp(pluginSrcDir, pluginDir, { recursive: true });
  await Promise.all(
    RUNTIME_STATE_FILES.map((name) => rm(path.join(pluginDir, name), { force: true })),
  );
}
