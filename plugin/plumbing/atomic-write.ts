/**
 * Atomic (temp-file + rename) write with fallback to direct write.
 *
 * Obsidian-free so it can be unit-tested with `deno test`.
 * Used only on desktop: mobile uses direct `writeBinary` to avoid
 * Capacitor rename regressions (see #181).
 */

export interface Adapter {
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

/**
 * Write `bytes` to `path` atomically via a temp file + rename.
 *
 * On ANY error (temp write or rename), falls back to a direct
 * `adapter.writeBinary(path, bytes)` so desktop can never regress
 * below the current direct-write status quo.
 */
export async function atomicWriteBinary(
  adapter: Adapter,
  path: string,
  bytes: Uint8Array,
) {
  const tmpPath = `${path}.tmp`;

  try {
    await adapter.writeBinary(tmpPath, bytes);
    await adapter.rename(tmpPath, path);
    return;
  } catch {
    // Fallback: direct write to target path.
    // This guarantees we never regress below status quo.
    try {
      await adapter.writeBinary(path, bytes);
    } finally {
      // Best-effort cleanup of leftover temp file.
      if (adapter.remove) {
        try {
          await adapter.remove(tmpPath);
        } catch {
          // Ignore: temp file will be overwritten next time.
        }
      }
    }
  }
}
