import { blobExists, getBlob, putBlob, removeStrandedTempFiles } from "../../../server/blobs.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { blake3 } from "@noble/hashes/blake3";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

function hashOf(bytes: Uint8Array): string {
  return Array.from(blake3(bytes) as unknown as number[]).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

const TEST_VAULT = "test-vault";

Deno.test({
  name: "blobs - putBlob with hash matching body writes file",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("hello world");
      const hash = hashOf(body);
      const result = await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(result.ok, true);
      const retrieved = await getBlob(dataDir, TEST_VAULT, hash);
      assert(retrieved !== null);
      assertEquals(new TextDecoder().decode(retrieved), "hello world");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob with mismatched hash stores blob (encrypted content)",
  async fn() {
    // The server stores encrypted blobs keyed by the plaintext chunk hash.
    // The body is encrypted, so the server cannot verify the hash.
    // Integrity is verified by the client during reassembly.
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("hello world");
      const fakeHash = "0".repeat(64);
      const result = await putBlob(dataDir, TEST_VAULT, fakeHash, body);
      assertEquals(result.ok, true);
      const exists = await blobExists(dataDir, TEST_VAULT, fakeHash);
      assertEquals(exists, true);
      const retrieved = await getBlob(dataDir, TEST_VAULT, fakeHash);
      assert(retrieved !== null);
      assertEquals(new TextDecoder().decode(retrieved), "hello world");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob with body > 4MB is rejected",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new Uint8Array(4 * 1024 * 1024 + 1);
      const hash = hashOf(body);
      const result = await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(result, { ok: false, reason: "too_large" });
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob with malformed hash is rejected",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("hello");
      const result = await putBlob(dataDir, TEST_VAULT, "not-a-hash", body);
      assertEquals(result, { ok: false, reason: "malformed_hash" });
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob twice with same content is idempotent",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("idempotent test");
      const hash = hashOf(body);
      const r1 = await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(r1.ok, true);
      const r2 = await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(r2.ok, true);
      const exists = await blobExists(dataDir, TEST_VAULT, hash);
      assertEquals(exists, true);
      const retrieved = await getBlob(dataDir, TEST_VAULT, hash);
      assert(retrieved !== null);
      assertEquals(new TextDecoder().decode(retrieved), "idempotent test");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - concurrent putBlob with same hash produces one valid file",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("concurrent test");
      const hash = hashOf(body);
      const results = await Promise.all([
        putBlob(dataDir, TEST_VAULT, hash, body),
        putBlob(dataDir, TEST_VAULT, hash, body),
        putBlob(dataDir, TEST_VAULT, hash, body),
      ]);
      for (const r of results) {
        assertEquals(r.ok, true);
      }
      const exists = await blobExists(dataDir, TEST_VAULT, hash);
      assertEquals(exists, true);
      const retrieved = await getBlob(dataDir, TEST_VAULT, hash);
      assert(retrieved !== null);
      assertEquals(new TextDecoder().decode(retrieved), "concurrent test");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob reports the bytes it added, 0 on a dedup hit",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const hash = "a".repeat(64);
      assertEquals(await putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(700)), {
        ok: true,
        bytesAdded: 700,
      });
      assertEquals(await putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(700)), {
        ok: true,
        bytesAdded: 0,
      });
      // A re-key overwrite (#557) replaces the ciphertext: only the delta counts.
      assertEquals(await putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(250), true), {
        ok: true,
        bytesAdded: -450,
      });
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - concurrent puts of one new hash add its bytes once",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const hash = "b".repeat(64);
      const results = await Promise.all([
        putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(300)),
        putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(300)),
        putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(300)),
      ]);
      const added = results.reduce((n, r) => n + (r.ok ? r.bytesAdded : 0), 0);
      assertEquals(added, 300, "the chunk's bytes are counted once, not once per request");
      assertEquals(
        (await Deno.stat(
          `${dataDir}/blobs/${TEST_VAULT}/${hash.slice(0, 2)}/${hash.slice(2)}`,
        )).size,
        300,
      );
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - getBlob returns null for missing hash",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const result = await getBlob(dataDir, TEST_VAULT, "0".repeat(64));
      assertEquals(result, null);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - blobExists returns true/false correctly",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      assertEquals(await blobExists(dataDir, TEST_VAULT, "0".repeat(64)), false);
      const body = new TextEncoder().encode("exists test");
      const hash = hashOf(body);
      await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(await blobExists(dataDir, TEST_VAULT, hash), true);
      assertEquals(await blobExists(dataDir, TEST_VAULT, "f".repeat(64)), false);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

function tmpFilesIn(shardDir: string): string[] {
  return [...Deno.readDirSync(shardDir)].map((e) => e.name).filter((n) => n.includes(".tmp-"));
}

Deno.test({
  name: "blobs - putBlob leaves no temp file after a successful put",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("temp cleanup test");
      const hash = hashOf(body);
      await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(tmpFilesIn(`${dataDir}/blobs/${TEST_VAULT}/${hash.slice(0, 2)}`), []);
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob removes its temp file when the write chain fails",
  async fn() {
    const dataDir = makeTempDataDir();
    // Fault injection past the point the temp file exists: `fsync` opens the file it just
    // wrote, and a throw there (a disk error in the field) used to leave the `.tmp-*` behind.
    const open = Deno.open;
    Deno.open = () => {
      throw new Deno.errors.PermissionDenied("injected open failure");
    };
    try {
      const hash = "c".repeat(64);
      const shardDir = `${dataDir}/blobs/${TEST_VAULT}/${hash.slice(0, 2)}`;
      await assertRejects(() => putBlob(dataDir, TEST_VAULT, hash, new Uint8Array(4)));
      assertEquals(tmpFilesIn(shardDir), [], "a failed write chain leaves no .tmp-* behind");
    } finally {
      Deno.open = open;
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - startup removes every stranded .tmp-* file and keeps real blobs",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      // Two vaults, a temp file each (the leftovers of a crash mid-write), plus a real blob
      // in each of them.
      const seeded: Array<[string, string]> = [];
      for (const vaultId of ["vaultA", "vaultB"]) {
        const body = new TextEncoder().encode(`body of ${vaultId}`);
        const hash = hashOf(body);
        await putBlob(dataDir, vaultId, hash, body);
        const shardDir = `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}`;
        await Deno.writeFile(`${shardDir}/${hash.slice(2)}.tmp-deadbeef`, new Uint8Array(9));
        seeded.push([vaultId, hash]);
      }

      assertEquals(removeStrandedTempFiles(dataDir), 2);
      for (const [vaultId, hash] of seeded) {
        const shardDir = `${dataDir}/blobs/${vaultId}/${hash.slice(0, 2)}`;
        assertEquals(tmpFilesIn(shardDir), [], `${vaultId} keeps no temp file`);
        assert(await blobExists(dataDir, vaultId, hash), `${vaultId} keeps its real blob`);
      }
      assertEquals(removeStrandedTempFiles(dataDir), 0, "a second pass finds nothing");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

// ── Vault-scoped blob tests (fixes #210) ─────────────────────────────

Deno.test({
  name: "blobs - dedup hit refreshes blob mtime (GC race)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const body = new TextEncoder().encode("dedup mtime refresh");
      const hash = hashOf(body);
      await putBlob(dataDir, TEST_VAULT, hash, body);
      const scoped = `${dataDir}/blobs/${TEST_VAULT}/${hash.slice(0, 2)}/${hash.slice(2)}`;
      const old = Date.now() - 40 * 24 * 3600 * 1000;
      Deno.utimeSync(scoped, new Date(old), new Date(old));

      // Re-uploading the same blob is a dedup hit; it must refresh the mtime
      // so GC's grace window doesn't delete a just-re-referenced blob.
      const r = await putBlob(dataDir, TEST_VAULT, hash, body);
      assertEquals(r.ok, true);

      const mtime = Deno.statSync(scoped).mtime?.getTime() ?? 0;
      assert(mtime > Date.now() - 60_000, "dedup hit must refresh blob mtime to ~now");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - vault isolation: same hash, different vaults, different ciphertext",
  async fn() {
    // The root cause of #210: the blob store is global and keyed by plaintext
    // chunk hash, but stored values are per-vault ciphertext. Two vaults with
    // identical plaintext produce the same hash but different ciphertext.
    const dataDir = makeTempDataDir();
    try {
      const hash = "a".repeat(64);
      const bytesA = new TextEncoder().encode("ciphertext for vault A");
      const bytesB = new TextEncoder().encode("ciphertext for vault B");

      await putBlob(dataDir, "vaultA", hash, bytesA);
      await putBlob(dataDir, "vaultB", hash, bytesB);

      const gotA = await getBlob(dataDir, "vaultA", hash);
      const gotB = await getBlob(dataDir, "vaultB", hash);

      assert(gotA !== null, "vaultA blob should exist");
      assert(gotB !== null, "vaultB blob should exist");
      assertEquals(gotA, bytesA, "vaultA must read its own ciphertext");
      assertEquals(gotB, bytesB, "vaultB must read its own ciphertext");
    } finally {
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "blobs - putBlob overwrite replaces an existing blob (re-key, #557)",
  async fn() {
    const dataDir = makeTempDataDir();
    try {
      const hash = "a".repeat(64);
      const oldCt = new TextEncoder().encode("old ciphertext");
      const newCt = new TextEncoder().encode("new ciphertext");

      await putBlob(dataDir, TEST_VAULT, hash, oldCt);
      // Default (dedup) put is a no-op on an existing blob...
      await putBlob(dataDir, TEST_VAULT, hash, newCt);
      assertEquals(await getBlob(dataDir, TEST_VAULT, hash), oldCt);
      // ...but overwrite replaces it (replace-mode re-key: same hash, new keys).
      const result = await putBlob(dataDir, TEST_VAULT, hash, newCt, true);
      assertEquals(result.ok, true);
      assertEquals(await getBlob(dataDir, TEST_VAULT, hash), newCt);
    } finally {
      removeTempDir(dataDir);
    }
  },
});
