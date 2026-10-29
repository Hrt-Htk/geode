import { normalizePath } from "../../core/normalize.ts";

export type EnumerateDiskVault = {
  adapter: {
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
    [key: string]: unknown;
  };
  getAllLoadedFiles: () => Array<{ path: string; children?: unknown }>;
};

/**
 * Enumerate files on disk via adapter.list (preferred) or getAllLoadedFiles (fallback).
 * @param vault The vault to enumerate.
 * @param dir The directory to start from ("" for vault root).
 * @param result Set to accumulate normalized file paths into.
 * @param opts.skipDir When set, skips this subtree (e.g. the vault's configDir).
 */
export async function enumerateDisk(
  vault: EnumerateDiskVault,
  dir: string,
  result: Set<string>,
  opts: { skipDir?: string },
): Promise<void> {
  if (!vault.adapter.list) {
    for (const f of vault.getAllLoadedFiles()) {
      if (!f.children) {
        result.add(normalizePath(f.path));
      }
    }
    return;
  }

  const { files, folders } = await vault.adapter.list(dir);
  for (const file of files) {
    result.add(normalizePath(file));
  }
  for (const folder of folders) {
    const normFolder = normalizePath(folder);
    if (
      opts.skipDir && (normFolder === opts.skipDir || normFolder.startsWith(opts.skipDir + "/"))
    ) {
      continue;
    }
    await enumerateDisk(vault, folder, result, opts);
  }
}
