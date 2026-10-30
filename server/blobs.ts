export const HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_BLOB_SIZE = 4 * 1024 * 1024; // 4 MB

/** #679: `bytesAdded` is the delta this PUT made, for the vault's byte counter. */
type PutResult = { ok: true; bytesAdded: number } | { ok: false; reason: string };

function shardDir(hash: string): string {
  return hash.slice(0, 2);
}

function scopedPath(dataDir: string, vaultId: string, hash: string): string {
  return `${dataDir}/blobs/${vaultId}/${shardDir(hash)}/${hash.slice(2)}`;
}

function scopedTmpPath(dataDir: string, vaultId: string, hash: string): string {
  const random = crypto.randomUUID().slice(0, 8);
  return `${dataDir}/blobs/${vaultId}/${shardDir(hash)}/${hash.slice(2)}.tmp-${random}`;
}

export async function getBlob(
  dataDir: string,
  vaultId: string,
  hash: string,
): Promise<Uint8Array | null> {
  const scoped = scopedPath(dataDir, vaultId, hash);
  try {
    return await Deno.readFile(scoped);
  } catch {
    return null;
  }
}

export async function blobExists(
  dataDir: string,
  vaultId: string,
  hash: string,
): Promise<boolean> {
  // Vault-scoped ONLY: no legacy fallback.
  try {
    await Deno.stat(scopedPath(dataDir, vaultId, hash));
    return true;
  } catch {
    return false;
  }
}

export async function putBlob(
  dataDir: string,
  vaultId: string,
  hash: string,
  body: Uint8Array,
  // #557: a re-keyed blob has the same plaintext hash but a NEW ciphertext;
  // the re-key PUT must overwrite, not treat the old file as a dedup hit.
  overwrite = false,
): Promise<PutResult> {
  if (!HASH_RE.test(hash)) {
    return { ok: false, reason: "malformed_hash" };
  }

  if (body.length > MAX_BLOB_SIZE) {
    return { ok: false, reason: "too_large" };
  }

  // Note: we do NOT verify hash == blake3(body) here. The blobs are encrypted
  // on the client side; the URL hash is the plaintext chunk hash, not the
  // encrypted body hash. Integrity is verified by the client during reassembly.

  const dest = scopedPath(dataDir, vaultId, hash);
  if (!overwrite) {
    // Dedup hit: refresh the mtime so GC's grace window keeps a just-re-referenced blob.
    // NotFound (absent, or GC won the race) falls through to a fresh write.
    try {
      await Deno.utime(dest, new Date(), new Date());
      return { ok: true, bytesAdded: 0 };
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  const scopedDirPath = `${dataDir}/blobs/${vaultId}/${shardDir(hash)}`;
  // recursive mkdir is idempotent on Linux; rename overwrites atomically (POSIX).
  await Deno.mkdir(scopedDirPath, { recursive: true });

  const tmp = scopedTmpPath(dataDir, vaultId, hash);
  try {
    await Deno.writeFile(tmp, body);
    const fd = await Deno.open(tmp, { write: true });
    try {
      await fd.sync();
    } finally {
      fd.close();
    }

    if (overwrite) {
      // #679: the counter needs the size this re-key rewrite replaces.
      let replaced = 0;
      try {
        replaced = (await Deno.stat(dest)).size;
      } catch {
        // absent: the whole body is new
      }
      await Deno.rename(tmp, dest);
      return { ok: true, bytesAdded: body.length - replaced };
    }

    try {
      await Deno.link(tmp, dest);
      return { ok: true, bytesAdded: body.length };
    } catch (e) {
      if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
      return { ok: true, bytesAdded: 0 };
    }
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

/** A `.tmp-*` file can only outlive its upload when the process died mid-write: nothing is in
 * flight before the server listens, so startup removes every one of them. */
export function removeStrandedTempFiles(dataDir: string): number {
  let vaults: Deno.DirEntry[];
  try {
    vaults = [...Deno.readDirSync(`${dataDir}/blobs`)];
  } catch {
    return 0; // no blobs dir yet
  }
  let removed = 0;
  for (const vault of vaults) {
    if (!vault.isDirectory) continue;
    const vaultDir = `${dataDir}/blobs/${vault.name}`;
    let shards: Deno.DirEntry[];
    try {
      shards = [...Deno.readDirSync(vaultDir)];
    } catch {
      continue;
    }
    for (const shard of shards) {
      if (!shard.isDirectory) continue;
      const shardPath = `${vaultDir}/${shard.name}`;
      let entries: Deno.DirEntry[];
      try {
        entries = [...Deno.readDirSync(shardPath)];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile || !entry.name.includes(".tmp-")) continue;
        try {
          Deno.removeSync(`${shardPath}/${entry.name}`);
          removed++;
        } catch {
          // already gone
        }
      }
    }
  }
  return removed;
}

/** Sum of this vault's blob file sizes; in-flight `.tmp-*` uploads don't count. */
export function vaultBlobBytes(dataDir: string, vaultId: string): number {
  const vaultDir = `${dataDir}/blobs/${vaultId}`;
  let shards: Deno.DirEntry[];
  try {
    shards = [...Deno.readDirSync(vaultDir)];
  } catch {
    return 0; // missing blobs dir
  }
  let bytes = 0;
  for (const shard of shards) {
    if (!shard.isDirectory) continue;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(`${vaultDir}/${shard.name}`)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile || entry.name.includes(".tmp-")) continue;
      try {
        bytes += Deno.statSync(`${vaultDir}/${shard.name}/${entry.name}`).size;
      } catch {
        // file vanished mid-walk
      }
    }
  }
  return bytes;
}

export async function gcUnreferencedBlobs(
  dataDir: string,
  vaultId: string,
  retained: Set<string>,
  now: number,
  graceMs: number,
): Promise<number> {
  const vaultDir = `${dataDir}/blobs/${vaultId}`;
  let shards: Deno.DirEntry[];
  try {
    shards = [...Deno.readDirSync(vaultDir)];
  } catch {
    return 0; // missing blobs dir
  }

  const cutoff = now - graceMs;
  let deleted = 0;
  for (const shard of shards) {
    if (!shard.isDirectory) continue;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(`${vaultDir}/${shard.name}`)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile) continue;
      const filename = entry.name;
      if (filename.includes(".tmp-")) continue; // in-flight upload: startup swept the stranded ones
      const hash = shard.name + filename;
      if (retained.has(hash)) continue;
      try {
        const stat = Deno.statSync(`${vaultDir}/${shard.name}/${filename}`);
        const mtime = stat.mtime?.getTime() ?? 0;
        if (mtime > cutoff) continue; // within mtime grace
        await Deno.remove(`${vaultDir}/${shard.name}/${filename}`);
        deleted++;
      } catch {
        // race: file already gone; treat as not ours to delete
      }
    }
  }
  return deleted;
}
