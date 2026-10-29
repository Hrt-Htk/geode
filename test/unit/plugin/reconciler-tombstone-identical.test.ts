import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";

function makeIsSyncable(): (path: string) => boolean {
  return (path: string) => !path.startsWith("/");
}

async function runReconciler(
  vault: FakeVault,
  state: StateDB,
): Promise<ReconcileOp[]> {
  let capturedOps: ReconcileOp[] = [];
  const reconciler = new Reconciler(
    vault as any,
    state,
    (ops) => {
      capturedOps = ops;
    },
    makeIsSyncable(),
    false,
    massDeleteGuard(),
  );
  reconciler.start();
  await reconciler.run(true);
  reconciler.stop();
  state.close();
  return capturedOps;
}

/**
 * Seed a TOMBSTONED (deleted: true) row whose plaintext_hash equals the disk
 * content, with a stale mtime so the reconciler hits the hash-check branch.
 */
function seedTombstone(
  vault: FakeVault,
  state: StateDB,
  path: string,
  diskMtime: number,
) {
  const bytes = vault.files.get(path)!;
  const normalized = normalizeForHash(path, bytes);
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: normalized.length,
    mtime: diskMtime - 1_000,
    plaintext_hash: blake3Hex(normalized),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: true,
  });
}

Deno.test("reconciler commits a tombstoned re-created file with identical content (mtime-drift branch)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  const path = "note.md";
  const diskMtime = 1_000_000;
  vault.files.set(path, new Uint8Array(new TextEncoder().encode("hello world")));
  vault.mtimes.set(path, diskMtime);
  seedTombstone(vault, state, path, diskMtime);

  const ops = await runReconciler(vault, state);
  const commitOps = ops.filter((o) => o.kind === "modify" || o.kind === "create");
  assertEquals(
    commitOps.map((o) => o.path),
    [path],
    "tombstoned identical-hash re-create must produce a commit op, not just an mtime bump",
  );
});

Deno.test("reconciler commits a tombstoned re-created file even when the mtime matches (fast path)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();

  const path = "note.md";
  const diskMtime = 1_000_000;
  vault.files.set(path, new Uint8Array(new TextEncoder().encode("hello world")));
  vault.mtimes.set(path, diskMtime);
  // Stored mtime matches disk: would normally fast-path skip, but the row is
  // tombstoned, so it must still be committed.
  const bytes = vault.files.get(path)!;
  const normalized = normalizeForHash(path, bytes);
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: normalized.length,
    mtime: diskMtime,
    plaintext_hash: blake3Hex(normalized),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: true,
  });

  const ops = await runReconciler(vault, state);
  const commitOps = ops.filter((o) => o.kind === "modify" || o.kind === "create");
  assertEquals(
    commitOps.map((o) => o.path),
    [path],
    "tombstoned row must not take the matching-mtime fast path",
  );
});
