// Filesystem usage of the data directory's filesystem via libc `statvfs` (FFI).
// Deno has no native statfs; the server runs Linux/glibc, so the x86_64 struct
// layout below is fixed. The library opens once and is never closed (server
// lifetime); the struct buffer is reused across calls (single-threaded, sync).

export interface FsUsage {
  total: number;
  free: number;
  used: number;
}

const libc = Deno.dlopen("libc.so.6", {
  statvfs: { parameters: ["buffer", "buffer"], result: "i32" },
});

// struct statvfs (x86_64 glibc), u64 LE: f_bsize@0 f_frsize@8 f_blocks@16 f_bfree@24 f_bavail@32.
const STATVFS = new DataView(new Uint8Array(112).buffer);

export function fsUsage(path: string): FsUsage {
  const rc = libc.symbols.statvfs(new TextEncoder().encode(path + "\0"), STATVFS);
  if (rc !== 0) throw new Error(`statvfs failed (rc=${rc})`);
  const frsize = Number(STATVFS.getBigUint64(8, true));
  const total = Number(STATVFS.getBigUint64(16, true)) * frsize; // f_blocks
  const used = total - Number(STATVFS.getBigUint64(24, true)) * frsize; // f_bfree
  const free = Number(STATVFS.getBigUint64(32, true)) * frsize; // f_bavail
  return { total, free, used };
}
