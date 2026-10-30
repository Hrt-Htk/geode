// Benchmark-vault re-key gate: a COPY of a real vault on a throwaway
// in-memory server is re-keyed (copy mode, then replace mode) and a fresh
// device cold-syncs the re-keyed vault: it must converge byte-identical to
// the pre-re-key content, the old passphrase must be dead, and history must
// decrypt under the new keys.
// NOT a *.test.ts: `deno test` / `test:ci` must never pick it up (needs a real-vault copy).
// Reads the source vault READ-ONLY into memory; never writes to the vault path.
// Run: GEODE_BENCH_VAULT_DIR=<real-vault-in-place> deno run -A --no-check test/bench/bench-rekey.ts
import { checkVerifier, decryptMetadata, deriveAuthKey, deriveKeys } from "../../core/crypto.ts";
import { hashPathHex, toHex } from "../../core/hash.ts";
import { b64decode } from "../../core/protocol.ts";
import { makeRekeyClient, putVaultAuth } from "../../plugin/plumbing/rekey-client.ts";
import { type RekeyCursor, type RekeyCursorStore, runRekey } from "../../plugin/sync/rekey-run.ts";
import { pair, TEST_KDF, TestPlugin } from "../two-vault-driver.ts";
import { arraysEqual } from "../helpers/bytes.ts";

type BenchFile = { path: string; data: Uint8Array };

const FAST = TEST_KDF;
const NEW_PASS = "bench-rekey-new-pass";
const NEWER_PASS = "bench-rekey-newer-pass";

const vaultDir = Deno.env.get("GEODE_BENCH_VAULT_DIR");
if (!vaultDir) {
  console.error(
    "GEODE_BENCH_VAULT_DIR is required: point it at a real vault (read in place, read-only).",
  );
  Deno.exit(2);
}

const allFiles = walkFiles(vaultDir);
const userFiles = allFiles.filter((f) => !f.path.startsWith(".obsidian/"));
const mdFiles = userFiles.filter((f) => f.path.endsWith(".md"));
const binSample = sampleBinaries(userFiles.filter((f) => !f.path.endsWith(".md")), 20);
if (mdFiles.length === 0) {
  console.error(`no markdown files found under ${vaultDir}`);
  Deno.exit(2);
}

const seed = [...mdFiles, ...binSample];
console.log(
  `seeding ${seed.length} files (${mdFiles.length} md + ${binSample.length} binaries) from ${vaultDir}`,
);

const paired = await pair();
const { A, B, server, vaultId } = paired;
const salt = b64decode(A.pluginSettings.salt);
const failures: string[] = [];

function memoryCursor(): RekeyCursorStore {
  let c: RekeyCursor | null = null;
  return {
    load: () => c,
    save: (x: RekeyCursor) => {
      c = x;
    },
    clear: () => {
      c = null;
    },
  };
}

function addDevice(name: string): { id: string; token: string } {
  const id = crypto.randomUUID();
  const token = `tok-${id.slice(0, 8)}`;
  server.db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    id,
    vaultId,
    name,
    token,
  );
  return { id, token };
}

function mapsEqual(
  a: Map<string, Uint8Array>,
  b: Map<string, Uint8Array>,
): { equal: boolean; diff: string[] } {
  const diff: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(key)) diff.push(`missing after rekey: ${key}`);
    else if (!b.has(key)) diff.push(`unexpected after rekey: ${key}`);
    else if (!arraysEqual(a.get(key)!, b.get(key)!)) diff.push(`content mismatch: ${key}`);
  }
  return { equal: diff.length === 0, diff };
}

function maxSeq(): number {
  const row = server.db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { s: number };
  return row.s;
}

/** A fresh device cold-syncs the re-keyed vault with `passphrase`; returns its file map. */
async function coldSyncFreshDevice(
  name: string,
  passphrase: string,
): Promise<Map<string, Uint8Array>> {
  const dev = addDevice(name);
  const dev2 = new TestPlugin({
    url: server.url,
    vaultId,
    deviceId: dev.id,
    deviceToken: dev.token,
    passphrase,
    saltBytes: salt,
  });
  await dev2.start();
  await dev2.waitForCaughtUp(await maxSeq());
  const files = new Map(dev2.fakeVault.files);
  dev2.stop();
  return files;
}

try {
  // ── Pre-re-key: seed the real vault, converge A→B ──────────────────────
  for (const f of seed) A.fakeVault.writeBinary(f.path, f.data);
  A.eventHandler.flushNow();
  await A.syncManager.reconcileNow();
  await A.waitForIdle(120_000);
  await settle(A, B);

  // Two versions of one note, so the history check spans a real chain.
  const sample = mdFiles[0].path;
  const first = A.fakeVault.files.get(sample)!;
  const second = new Uint8Array(first.length + 16);
  second.set(first);
  new TextEncoder().encodeInto("\nsecond version\n", second, first.length);
  A.fakeVault.writeBinary(sample, second);
  A.eventHandler.flushNow();
  await A.syncManager.reconcileNow();
  await settle(A, B);

  const preRekey = new Map(A.fakeVault.files);
  console.log(`pre-rekey: A and B converged on ${preRekey.size} files`);

  // ── Check 1: copy re-key → fresh device converges byte-identical ───────
  await runCheck(1, async () => {
    console.log("[1] copy re-key on the real vault");
    const oldKeys = A.keys;
    await putVaultAuth(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      toHex(deriveAuthKey(oldKeys)),
      server.adminToken,
    );
    const newKeys = await deriveKeys(NEW_PASS, salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
    const client = makeRekeyClient(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      toHex(deriveAuthKey(oldKeys)),
    );
    const t0 = Date.now();
    await runRekey({
      oldKeys,
      newKeys,
      params: FAST,
      mode: "copy",
      client,
      cursor: memoryCursor(),
    });
    console.log(`    copy re-key done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    // The old keys no longer verify; the new ones do.
    const row = server.db
      .prepare("SELECT verifier FROM vaults WHERE id = ?")
      .get(vaultId) as { verifier: string };
    const oldDead = !(await checkVerifier(oldKeys, b64decode(row.verifier)));
    const newLive = await checkVerifier(newKeys, b64decode(row.verifier));

    A.stop();
    B.stop();
    const fresh = await coldSyncFreshDevice("rekey-copy-A2", NEW_PASS);
    const eq = mapsEqual(preRekey, fresh);
    if (oldDead && newLive && eq.equal) {
      pass(
        1,
        `copy re-key: old passphrase dead, new live, fresh device converged on all ${fresh.size} files`,
      );
    } else {
      fail(
        1,
        `oldDead=${oldDead} newLive=${newLive} equal=${eq.equal} ` +
          (eq.equal ? "" : `divergent: ${eq.diff.slice(0, 5).join(", ")}`),
      );
    }

    // History: the sample note's two-version chain lives under the NEW path
    // hash and decrypts.
    const h = hashPathHex(newKeys.mac_key, sample);
    const newClient = makeRekeyClient(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      toHex(deriveAuthKey(newKeys)),
    );
    const chain = await newClient.versionChain(h);
    let pathsOk = chain.length >= 2;
    for (const v of chain) {
      if ((await decryptMetadata(b64decode(v.enc_metadata), newKeys, h)).path !== sample) {
        pathsOk = false;
        break;
      }
    }
    if (!pathsOk) {
      fail(
        1,
        `history chain for ${sample}: length=${chain.length} (expected >= 2), paths decrypt correctly`,
      );
    }
  });

  // ── Check 2: replace re-key (second pass) → fresh device converges ─────
  await runCheck(2, async () => {
    console.log("[2] replace re-key on the re-keyed vault");
    const oldKeys = await deriveKeys(NEW_PASS, salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
    const newKeys = await deriveKeys(NEWER_PASS, salt, { opsLimit: FAST.ops, memLimit: FAST.mem });
    const client = makeRekeyClient(
      server.url,
      vaultId,
      A.pluginSettings.deviceToken,
      toHex(deriveAuthKey(oldKeys)),
    );
    const t0 = Date.now();
    await runRekey({
      oldKeys,
      newKeys,
      params: FAST,
      mode: "replace",
      client,
      cursor: memoryCursor(),
    });
    console.log(`    replace re-key done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    const row = server.db
      .prepare("SELECT verifier FROM vaults WHERE id = ?")
      .get(vaultId) as { verifier: string };
    const oldDead = !(await checkVerifier(oldKeys, b64decode(row.verifier)));
    const newLive = await checkVerifier(newKeys, b64decode(row.verifier));

    const fresh = await coldSyncFreshDevice("rekey-replace-A3", NEWER_PASS);
    const eq = mapsEqual(preRekey, fresh);
    if (oldDead && newLive && eq.equal) {
      pass(
        2,
        `replace re-key: old passphrase dead, new live, fresh device converged on all ${fresh.size} files`,
      );
    } else {
      fail(
        2,
        `oldDead=${oldDead} newLive=${newLive} equal=${eq.equal} ` +
          (eq.equal ? "" : `divergent: ${eq.diff.slice(0, 5).join(", ")}`),
      );
    }
  });
} finally {
  await paired.stop();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} benchmark check(s) FAILED`);
  Deno.exit(1);
}
console.log("\nAll benchmark re-key checks PASS");
Deno.exit(0);

// ── Helpers ────────────────────────────────────────────────────────────

/** Recursively read a directory into memory (source vault stays untouched). */
function walkFiles(dir: string, prefix = ""): BenchFile[] {
  const out: BenchFile[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      out.push(...walkFiles(full, rel));
    } else if (entry.isFile) {
      out.push({ path: rel, data: Deno.readFileSync(full) });
    }
  }
  return out;
}

/** Deterministic size-spread sample of `k` binaries. */
function sampleBinaries(files: BenchFile[], k: number): BenchFile[] {
  const sorted = [...files].sort((a, b) => a.data.length - b.data.length);
  if (sorted.length <= k) return sorted;
  const step = sorted.length / k;
  return Array.from({ length: k }, (_, i) => sorted[Math.floor(i * step)]);
}

/** Settle A and B to quiescence (stable server count + both caught up). */
async function settle(A: TestPlugin, B: TestPlugin, maxRounds = 15): Promise<void> {
  let prev = -1;
  for (let round = 0; round < maxRounds; round++) {
    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    const count = versionCount();
    if (count === prev) {
      const s = await maxSeq();
      await A.waitForCaughtUp(s);
      await B.waitForCaughtUp(s);
      return;
    }
    prev = count;
  }
  throw new Error(`settle: no convergence after ${maxRounds} rounds`);
}

function versionCount(): number {
  const row = server.db
    .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
    .get(vaultId) as { n: number };
  return row.n;
}

async function runCheck(n: number, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    fail(n, e instanceof Error ? e.message : String(e));
  }
}

function pass(n: number, detail: string): void {
  console.log(`PASS check ${n}: ${detail}`);
}

function fail(n: number, detail: string): void {
  console.error(`FAIL check ${n}: ${detail}`);
  failures.push(`check ${n}`);
}
