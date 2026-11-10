// A vault double for tests that need the disk side of apply, the rename carry and the
// reconciler: a plain path → text map behind Obsidian's index and adapter calls.

/** A disk whose paths resolve case-insensitively AND case-sensitively: on APFS/NTFS a
 * case-only rename leaves one inode for "a.md" and "A.md", where ext4 keeps two. */
export function diskVault(files: Record<string, string>, opts: { caseInsensitive?: boolean } = {}) {
  const disk = new Map(Object.entries(files));
  const key = (p: string) => {
    if (!opts.caseInsensitive) return p;
    for (const k of disk.keys()) if (k.toLowerCase() === p.toLowerCase()) return k;
    return p;
  };
  const encoder = new TextEncoder();
  // Byte-faithful: TextDecoder drops a UTF-8 BOM by default, and the plugin's identity hash
  // strips it only for markdown.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return {
    getAbstractFileByPath: (p: string) => (disk.has(key(p)) ? { path: key(p) } : null),
    getAllLoadedFiles: () => [...disk.keys()].map((path) => ({ path })),
    adapter: {
      readBinary: (p: string) => {
        const body = disk.get(key(p));
        if (body === undefined) return Promise.reject(new Error(`missing: ${p}`));
        return Promise.resolve(encoder.encode(body));
      },
      writeBinary: (p: string, data: Uint8Array) => {
        disk.set(p, decoder.decode(data));
        return Promise.resolve();
      },
      remove: (p: string) => {
        disk.delete(key(p));
        return Promise.resolve();
      },
      exists: (p: string) => Promise.resolve(disk.has(key(p))),
      stat: (p: string) => Promise.resolve(disk.has(key(p)) ? { size: 1, mtime: 4 } : null),
    },
    disk,
  };
}
