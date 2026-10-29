// The vault's filesystem surface: every read, write, remove and stat the sync code
// does against Obsidian. Kept apart from the apply rules so the bridge contract (one
// reason to change: the adapter/index API) has its own module.

import { blake3Hex } from "../../core/hash.ts";
import { normalizeForHash } from "../../core/normalize.ts";
import { toUint8Array } from "../plumbing/bytes.ts";
import { log } from "../plumbing/log.ts";

/** The vault surface apply, the rename link and commit touch (Obsidian's vault is a
 * superset, so sync code and the conflict handler can pass theirs unchanged). */
export type Vault = {
  getAbstractFileByPath?: (path: string) => unknown | null;
  createBinary?: (
    path: string,
    data: ArrayBuffer,
    opts?: { mtime?: number },
  ) => Promise<unknown>;
  modifyBinary?: (
    file: unknown,
    data: ArrayBuffer,
    opts?: { mtime?: number },
  ) => Promise<void>;
  delete?: (file: unknown, force?: boolean) => Promise<void>;
  /** Obsidian's `vault.rename`; absent only on the narrow test doubles. */
  rename?: (file: unknown, newPath: string) => Promise<void>;
  adapter: {
    readBinary?: (path: string) => Promise<Uint8Array>;
    writeBinary: (path: string, data: Uint8Array, opts?: { mtime?: number }) => Promise<void>;
    remove: (path: string) => Promise<void>;
    exists?: (path: string) => Promise<boolean>;
    stat?: (path: string) => Promise<{ size: number; mtime: number } | null>;
    mkdir?: (path: string) => Promise<void>;
  };
};

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

export async function writeVaultBinary(
  path: string,
  bytes: Uint8Array,
  mtime: number,
  vault: Vault,
): Promise<void> {
  await ensureParentDirs(path, vault);
  const existing = vault.getAbstractFileByPath?.(path) ?? null;
  if (existing && typeof vault.modifyBinary === "function") {
    await vault.modifyBinary(
      existing,
      copyToArrayBuffer(bytes),
      { mtime },
    );
    return;
  }
  if (typeof vault.createBinary === "function") {
    try {
      await vault.createBinary(
        path,
        copyToArrayBuffer(bytes),
        { mtime },
      );
      return;
    } catch (error) {
      // File exists on disk but not in the index (dot-file / pre-index): write
      // via the adapter. Logged so a genuine createBinary failure isn't silent.
      log.debug("createBinary failed, writing via adapter", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await vault.adapter.writeBinary(path, bytes, { mtime });
}

/** #697: the handle a vault rename can move: the index knows this path and the vault has
 * the API. A path the index does not know (config/dot-file) has no editor to keep. */
export function renameableFile(path: string, vault: Vault): unknown | null {
  if (typeof vault.rename !== "function") return null;
  return vault.getAbstractFileByPath?.(path) ?? null;
}

/** #697: move `file` with the vault's own rename: Obsidian takes an open editor with it,
 * where write + remove tears the editor down with the old name (#695). False = the rename
 * failed (no parent folder to create, a read-only vault): the caller falls back to write +
 * remove, and nothing escapes the apply. A rename fires only a `rename` event. */
export async function renameVaultFile(
  file: unknown,
  to: string,
  vault: Vault,
): Promise<boolean> {
  if (vault.rename === undefined) return false;
  try {
    await ensureParentDirs(to, vault);
    // Called on the vault: a vault method extracted into a local loses `this`.
    await vault.rename(file, to);
    return true;
  } catch (error) {
    log.warn("vault rename failed, writing and removing instead", {
      to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function removeVaultPath(path: string, vault: Vault): Promise<void> {
  const existing = vault.getAbstractFileByPath?.(path) ?? null;
  if (existing && typeof vault.delete === "function") {
    await vault.delete(existing);
    return;
  }
  await vault.adapter.remove(path);
}

export async function readVaultBinary(path: string, vault: Vault): Promise<Uint8Array | null> {
  if (typeof vault.adapter.readBinary !== "function") return null;
  try {
    return toUint8Array(await vault.adapter.readBinary(path));
  } catch {
    return null; // absent or unreadable -> nothing to carry over
  }
}

export async function diskPlaintextHash(path: string, vault: Vault): Promise<string | null> {
  const raw = await readVaultBinary(path, vault);
  return raw === null ? null : blake3Hex(normalizeForHash(path, raw));
}

/** `diskPlaintextHash`, but a positively absent file costs a stat instead of a
 * failed full read: an empty device applies every file of a join/catch-up. A
 * throwing adapter is NOT absence (#505): read it and let the read decide. */
export async function diskPlaintextHashIfPresent(
  path: string,
  vault: Vault,
): Promise<string | null> {
  const stat = await Promise.resolve(vault.adapter.stat?.(path)).catch(() => undefined);
  if (stat === null) return null;
  return await diskPlaintextHash(path, vault);
}

export async function ensureParentDirs(path: string, vault: Vault): Promise<void> {
  if (typeof vault.adapter.exists !== "function" || typeof vault.adapter.mkdir !== "function") {
    return;
  }

  let current = "";
  for (const part of path.split("/").slice(0, -1)) {
    current = current ? `${current}/${part}` : part;
    if (vault.getAbstractFileByPath?.(current)) {
      continue; // in-memory index knows this folder: skip the bridge exists()
    }
    if (!(await vault.adapter.exists(current))) {
      await vault.adapter.mkdir(current);
    }
  }
}
