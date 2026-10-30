// Benchmark-vault gate: real-content convergence + real .obsidian discovery.
// NOT a *.test.ts: `deno test` / `test:ci` must never pick it up (needs a real-vault copy).
// Reads the source vault READ-ONLY into memory; never writes to the vault path.
// Run: GEODE_BENCH_VAULT_DIR=<real-vault-in-place> deno run -A --no-check test/bench/bench-real.ts
import { pair, TestPlugin } from "../two-vault-driver.ts";
import { arraysEqual } from "../helpers/bytes.ts";
import { isSyncable } from "../../plugin/plumbing/settings-types.ts";
import { isConflictPath } from "../../plugin/sync/conflicts.ts";
import { hashPathHex } from "../../core/hash.ts";
import { decryptMetadata } from "../../core/crypto.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../core/protocol.ts";
import {
  type BenchDb,
  configCount,
  configVersions,
  mapsEqual,
  pushAndDrain,
  sampleBinaries,
  settle,
  versionCount,
  walkFiles,
  withoutConfig,
} from "./bench-helpers.ts";

interface StormRename {
  from: string;
  to: string;
  /** Interleaved round the rename lands in (0-2). */
  round: number;
}

const SYNCED_PLUGINS = ["obsidian-linter", "colored-text"];
const UNSYNCED_PLUGIN = "homepage";

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
const obsidianFiles = allFiles.filter((f) => f.path.startsWith(".obsidian/"));

if (mdFiles.length === 0) {
  console.error(`no markdown files found under ${vaultDir}`);
  Deno.exit(2);
}
// Check 3 edits one note turn after turn, so it must be multi-line: a one-line note
// makes the per-turn line index degenerate. Deterministic (sorted), not the first
// file the directory walk happened to yield.
const CONFLICT_NOTE = [...mdFiles]
  .sort((a, b) => a.path.localeCompare(b.path))
  .find((f) => new TextDecoder().decode(f.data).split("\n").length >= 3)?.path;
if (!CONFLICT_NOTE) {
  console.error(
    `no markdown file with a multi-line body (>= 3 lines) under ${vaultDir}: ` +
      "the repeated-conflict check needs one",
  );
  Deno.exit(2);
}

const paired = await pair();
const { A, B, server, vaultId } = paired;
const failures: string[] = [];

try {
  await runCheck(1, async () => {
    // ── Check 1: first-sync convergence ────────────────────────────────
    const seed = [...mdFiles, ...binSample];
    console.log(
      `[1] first-sync: seeding ${seed.length} files (${mdFiles.length} md + ${binSample.length} binaries) into A`,
    );
    for (const f of seed) A.fakeVault.writeBinary(f.path, f.data);
    await pushAndDrain(A);
    await settle([A, B], server.db, vaultId);
    const versions1 = versionCount(server.db, vaultId);
    const eq1 = mapsEqual(A.fakeVault.files, B.fakeVault.files);
    if (versions1 === seed.length && eq1.equal) {
      pass(1, `first-sync convergence (${seed.length} files, server versions == ${versions1})`);
    } else {
      fail(
        1,
        `server versions=${versions1} expected=${seed.length}; ` +
          (eq1.equal ? "" : `divergent paths: ${eq1.diff.slice(0, 5).join(", ")}`),
      );
    }
  });

  await runCheck(2, async () => {
    // ── Check 2: .obsidian discovery (syncObsidianConfig ON) ───────────
    console.log("[2] .obsidian discovery with syncObsidianConfig ON");
    // Scope is per device: both devices need the toggle for B to pull .obsidian.
    for (const dev of [A, B]) {
      dev.pluginSettings.syncObsidianConfig = true;
      dev.pluginSettings.syncedPlugins = SYNCED_PLUGINS;
      dev.syncManager.setSyncObsidianConfig(true);
    }
    const before2 = versionCount(server.db, vaultId);
    // Seed via direct map writes: .obsidian files never emit events in real
    // Obsidian (hidden from the file API), so writeBinary() would commit them
    // bypassing isSyncable via the event path. Direct writes force the
    // reconciler's scanObsidianDir discovery, which filters by isSyncable.
    for (const f of obsidianFiles) A.fakeVault.files.set(f.path, new Uint8Array(f.data));
    // These exist only in the bench harness; isSyncable must exclude them by name.
    A.fakeVault.files.set(".obsidian/workspace.json", new TextEncoder().encode('{"dummy":true}'));
    A.fakeVault.files.set(".obsidian/graph.json", new TextEncoder().encode('{"dummy":true}'));
    await pushAndDrain(A);
    await settle([A, B], server.db, vaultId);
    const after2 = versionCount(server.db, vaultId);
    const expected2 = obsidianFiles.filter((f) =>
      isSyncable(f.path, ".obsidian", A.pluginSettings)
    ).length;
    const noStorm2 = await settle([A, B], server.db, vaultId); // true = extra settle added no versions
    const stable2 = versionCount(server.db, vaultId);

    const checks2 = [
      after2 - before2 === expected2,
      B.fakeVault.files.has(`.obsidian/plugins/${SYNCED_PLUGINS[0]}/data.json`),
      B.fakeVault.files.has(`.obsidian/plugins/${SYNCED_PLUGINS[1]}/manifest.json`),
      !B.fakeVault.files.has(`.obsidian/plugins/${UNSYNCED_PLUGIN}/data.json`),
      !B.fakeVault.files.has(".obsidian/workspace.json"),
      !B.fakeVault.files.has(".obsidian/graph.json"),
      B.fakeVault.files.has(".obsidian/snippets/Snipet 1.css"),
    ];
    if (checks2.every(Boolean) && noStorm2 && stable2 === after2) {
      pass(
        2,
        `.obsidian discovery (${expected2} files, version delta == file count, stable across extra settle)`,
      );
    } else {
      const detail = [
        `version delta=${after2 - before2} expected=${expected2}`,
        `synced plugin A on B: ${
          B.fakeVault.files.has(`.obsidian/plugins/${SYNCED_PLUGINS[0]}/data.json`)
        }`,
        `synced plugin B on B: ${
          B.fakeVault.files.has(`.obsidian/plugins/${SYNCED_PLUGINS[1]}/manifest.json`)
        }`,
        `unsynced plugin excluded: ${!B.fakeVault.files.has(
          `.obsidian/plugins/${UNSYNCED_PLUGIN}/data.json`,
        )}`,
        `workspace.json excluded: ${!B.fakeVault.files.has(".obsidian/workspace.json")}`,
        `graph.json excluded: ${!B.fakeVault.files.has(".obsidian/graph.json")}`,
        `nested snippet on B: ${B.fakeVault.files.has(".obsidian/snippets/Snipet 1.css")}`,
        `extra settle storm: ${!noStorm2} (stable=${stable2} vs after=${after2})`,
      ].join("; ");
      fail(2, detail);
    }
  });

  await runCheck(3, async () => {
    // ── Check 3: repeated-conflict accumulation on one real note ───────
    console.log(`[3] repeated-conflict accumulation on "${CONFLICT_NOTE}"`);
    const turnTokens: string[][] = [];
    let converged = true;
    for (let turn = 0; turn < 3; turn++) {
      const base = new TextDecoder().decode(A.fakeVault.files.get(CONFLICT_NOTE)!).split("\n");
      const tokenA = `BENCH_A_${turn}`;
      const tokenB = `BENCH_B_${turn}`;
      const idxA = turn % base.length;
      const idxB = (turn + 1) % base.length;
      const linesA = [...base];
      const linesB = [...base];
      linesA[idxA] += ` ${tokenA}`;
      linesB[idxB] += ` ${tokenB}`;
      A.fakeVault.write(CONFLICT_NOTE, linesA.join("\n"), {
        mtime: 1_700_000_000_000 + turn * 1000 + 1,
      });
      B.fakeVault.write(CONFLICT_NOTE, linesB.join("\n"), {
        mtime: 1_700_000_000_000 + turn * 1000 + 2,
      });
      await A.pushNow();
      await B.pushNow();
      await settle([A, B], server.db, vaultId);
      await B.reconcileNow();

      const aData = A.fakeVault.files.get(CONFLICT_NOTE);
      const bData = B.fakeVault.files.get(CONFLICT_NOTE);
      if (!aData || !bData || !arraysEqual(aData, bData)) converged = false;
      turnTokens.push([tokenA, tokenB]);
    }

    const allText = [...A.fakeVault.files.values()].map((d) => new TextDecoder().decode(d)).join(
      "\n",
    );
    const allTokensSurvive = turnTokens.every(([ta, tb]) =>
      allText.includes(ta) && allText.includes(tb)
    );
    if (converged && allTokensSurvive) {
      pass(3, `3 conflict turns converged, both edits survive each turn (6 tokens on disk)`);
    } else {
      fail(3, `frozen divergence=${!converged}, all-tokens-survive=${allTokensSurvive}`);
    }
  });
  await runCheck(4, async () => {
    // ── Check 4: rename a real note (#583) ─────────────────────────────
    // The old name must vanish on both devices, the content must converge at the
    // new one, and the server must hold exactly one marker + one note: with no
    // trash entry (a marker is not a deletion).
    const from = CONFLICT_NOTE;
    const to = `Renamed ${CONFLICT_NOTE}`;
    console.log(`[4] rename "${from}" -> "${to}"`);
    const trashBefore = trashCount(server.db, vaultId);
    A.fakeVault.rename(from, to);
    await pushAndDrain(A);
    await settle([A, B], server.db, vaultId);
    // .obsidian is per-device scope: A keeps the deliberately unsynced plugin, so
    // compare the user files (as check 1 does).
    const eq4 = mapsEqual(withoutConfig(A.fakeVault.files), withoutConfig(B.fakeVault.files));
    const named = {
      old: headOf(server.db, vaultId, A, from),
      moved: headOf(server.db, vaultId, A, to),
    };
    const checks4 = [
      eq4.equal,
      !A.fakeVault.files.has(from),
      !B.fakeVault.files.has(from),
      B.fakeVault.files.has(to),
      named.old?.rename_mark === RENAME_MARKER && named.old.deleted === 1,
      named.moved?.rename_mark === RENAME_NOTE && named.moved.deleted === 0,
      trashCount(server.db, vaultId) === trashBefore,
    ];
    if (checks4.every(Boolean)) {
      pass(
        4,
        `rename (${to.length} chars, real content) converged, marker+note on the server, trash unchanged`,
      );
    } else {
      fail(
        4,
        [
          `converged=${eq4.equal}${eq4.equal ? "" : ` (${eq4.diff.slice(0, 3).join(", ")})`}`,
          `old gone on A=${!A.fakeVault.files.has(from)} B=${!B.fakeVault.files.has(from)}`,
          `new on B=${B.fakeVault.files.has(to)}`,
          `old head=${JSON.stringify(named.old)} new head=${JSON.stringify(named.moved)}`,
          `trash ${trashBefore} -> ${trashCount(server.db, vaultId)}`,
        ].join("; "),
      );
    }
  });

  await runCheck(5, async () => {
    // ── Check 5: rename storm on ~10% of the real tree (#587 item 4) ────
    // One whole folder moves with its children, a few notes move across folders
    // and the rest are renamed in place: over three interleaved rounds while
    // both devices keep editing real notes. A is paused through round 2 holding
    // edits queued on notes B renames while it is away.
    const { renames, movedFolder } = stormPlan([...A.fakeVault.files.keys()]);
    console.log(
      `[5] rename storm: ${renames.length} renames (folder "${movedFolder}" moves with its children), 3 rounds, A paused in round 2`,
    );
    const trashBefore5 = trashCount(server.db, vaultId);
    const configBefore5 = [A, B].map((dev) => configCount(dev.fakeVault.files));
    const configPaths = [...A.fakeVault.files.keys()].filter((p) => p.startsWith(".obsidian/"));
    const versionsBefore5 = configVersions(server.db, vaultId, A.keys!, configPaths);
    const tokens: string[] = [];
    const edited = new Set<string>();

    /** A user edit: a unique token appended to a real .md note. */
    const edit = (dev: TestPlugin, path?: string): void => {
      const target = path ?? unusedNote(dev, edited);
      edited.add(target);
      const token = `BENCH_STORM_${tokens.length}_${dev === A ? "A" : "B"}`;
      tokens.push(token);
      const body = new TextDecoder().decode(dev.fakeVault.files.get(target)!);
      dev.fakeVault.write(target, `${body}\n${token}`);
    };
    const notesOnly = (r: StormRename) => r.from.endsWith(".md") && !isConflictPath(r.from);

    // Round 1: B saves two notes while A renames them.
    const round1 = renames.filter((r) => r.round === 0);
    for (const r of round1.filter(notesOnly).slice(0, 2)) edit(B, r.from);
    for (const r of round1) A.fakeVault.rename(r.from, r.to);
    for (let i = 0; i < 3; i++) edit(A);
    for (let i = 0; i < 3; i++) edit(B);
    await pushAndDrain(A);
    await pushAndDrain(B);
    await settle([A, B], server.db, vaultId);

    // Round 2: A goes offline with edits queued on notes B is about to move.
    A.pause();
    const round2 = renames.filter((r) => r.round === 1);
    for (const r of round2.filter(notesOnly).slice(0, 2)) edit(A, r.from);
    for (let i = 0; i < 2; i++) edit(A);
    for (const r of round2) B.fakeVault.rename(r.from, r.to);
    for (let i = 0; i < 3; i++) edit(B);
    await pushAndDrain(B);
    await settle([B], server.db, vaultId);
    // A comes back: its queued edits land in a world where those names moved.
    await A.resume();
    await pushAndDrain(A);
    await settle([A, B], server.db, vaultId);

    // Round 3: both devices rename at once while both keep writing.
    const round3 = renames.filter((r) => r.round === 2);
    round3.forEach((r, i) => (i % 2 === 0 ? A : B).fakeVault.rename(r.from, r.to));
    for (let i = 0; i < 3; i++) edit(A);
    for (let i = 0; i < 3; i++) edit(B);
    await pushAndDrain(A);
    await pushAndDrain(B);
    await settle([A, B], server.db, vaultId);

    const eq5 = mapsEqual(withoutConfig(A.fakeVault.files), withoutConfig(B.fakeVault.files));
    // Convergence alone would also pass if a rename dropped the file on BOTH devices.
    const missingDest = renames.filter((r) =>
      !A.fakeVault.files.has(r.to) || !B.fakeVault.files.has(r.to)
    );
    const resurrected = renames.filter((r) =>
      A.fakeVault.files.has(r.from) || B.fakeVault.files.has(r.from)
    );
    const folderLeft = [...A.fakeVault.files.keys(), ...B.fakeVault.files.keys()]
      .filter((p) => p.startsWith(`${movedFolder}/`));
    const texts = [A, B].map((dev) =>
      [...dev.fakeVault.files.values()].map((d) => new TextDecoder().decode(d)).join("\n")
    );
    const lost = tokens.filter((t) => texts.some((text) => !text.includes(t)));
    const broken = await renameLinks(server.db, vaultId, A.keys!, renames);
    const configAfter5 = [A, B].map((dev) => configCount(dev.fakeVault.files));
    const versionsAfter5 = configVersions(server.db, vaultId, A.keys!, configPaths);
    const trashAfter5 = trashCount(server.db, vaultId);

    const checks5 = [
      eq5.equal,
      missingDest.length === 0,
      resurrected.length === 0,
      folderLeft.length === 0,
      lost.length === 0,
      broken.length === 0,
      trashAfter5 === trashBefore5,
      configAfter5.every((n, i) => n === configBefore5[i]),
      versionsAfter5 === versionsBefore5,
    ];
    if (checks5.every(Boolean)) {
      pass(
        5,
        `${renames.length} renames over 3 rounds converged, ${tokens.length} edits survived, ` +
          `one marker + one note per rename, trash (${trashAfter5}) and .obsidian unchanged`,
      );
    } else {
      fail(
        5,
        [
          `converged=${eq5.equal}${eq5.equal ? "" : ` (${eq5.diff.slice(0, 3).join(", ")})`}`,
          `missing destinations: ${missingDest.slice(0, 3).map((r) => r.to).join(", ") || "none"}`,
          `resurrected: ${resurrected.slice(0, 3).map((r) => r.from).join(", ") || "none"}`,
          `old folder left: ${folderLeft.slice(0, 3).join(", ") || "none"}`,
          `lost edits: ${lost.slice(0, 3).join(", ") || "none"}`,
          `broken links: ${broken.slice(0, 4).join(" | ") || "none"}`,
          `trash ${trashBefore5} -> ${trashAfter5}`,
          `config files A ${configBefore5[0]}->${configAfter5[0]} B ${configBefore5[1]}->${
            configAfter5[1]
          }`,
          `config versions ${versionsBefore5} -> ${versionsAfter5}`,
        ].join("; "),
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
console.log("\nAll 5 benchmark checks PASS");
Deno.exit(0);

// ── Helpers ────────────────────────────────────────────────────────────

/** A real .md path on `dev` not yet edited: rebuilt per call, because a rename
 * moves names out of the tree. */
function unusedNote(dev: TestPlugin, edited: Set<string>): string {
  const notes = [...dev.fakeVault.files.keys()]
    .filter((p) =>
      p.endsWith(".md") && !p.startsWith(".obsidian/") && !isConflictPath(p) && !edited.has(p)
    )
    .sort();
  if (notes.length === 0) throw new Error("rename storm: no unedited note left");
  return notes[edited.size % notes.length];
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** ~10 % of the vault's user files: one whole folder moved with its children, a
 * few files moved across folders, the rest renamed in place: spread over three
 * rounds. Deterministic (no RNG): a failing storm replays exactly. */
function stormPlan(paths: string[]): { renames: StormRename[]; movedFolder: string } {
  const files = paths
    .filter((p) => !p.startsWith(".obsidian/") && !isConflictPath(p))
    .sort();
  const target = Math.round(files.length / 10);
  const under = (folder: string) => files.filter((p) => p.startsWith(`${folder}/`));
  const folders = [...new Set(files.map(folderOf))].filter((f) => f !== "").sort();
  // The folder move: the largest folder of 3-12 files, moved with everything under it.
  const [movedFolder] = folders
    .filter((f) => under(f).length >= 3 && under(f).length <= 12)
    .sort((a, b) => under(b).length - under(a).length || a.localeCompare(b));
  if (!movedFolder) throw new Error("rename storm: no folder of 3-12 files to move");
  const children = under(movedFolder);
  const renames: StormRename[] = children.map((from) => ({
    from,
    to: `${movedFolder} (moved)/${from.slice(movedFolder.length + 1)}`,
    round: 1,
  }));

  const used = new Set(children);
  const rest = files.filter((p) => !used.has(p));
  // Destinations live outside the folder being moved (its old name disappears).
  const movedFolders = folders.filter((f) => f !== movedFolder && !f.startsWith(`${movedFolder}/`));
  const need = target - renames.length;
  const step = Math.max(1, Math.floor(rest.length / need));
  for (let i = 0, picked = 0; i < rest.length && picked < need; i += step, picked++) {
    const from = rest[i];
    // The first four are moves into another real folder; the rest rename in place.
    const folder = picked < 4 ? movedFolders[picked % movedFolders.length] : folderOf(from);
    const to = `${folder === "" ? "" : `${folder}/`}storm-${picked} ${
      from.slice(from.lastIndexOf("/") + 1)
    }`;
    renames.push({ from, to, round: picked < need / 3 ? 0 : picked < (2 * need) / 3 ? 1 : 2 });
  }
  return { renames, movedFolder };
}

/** #583: one marker on the old path and one note on the new path per rename,
 * matched by the encrypted link the row carries (not by row position). */
async function renameLinks(
  db: BenchDb,
  vaultId: string,
  keys: NonNullable<TestPlugin["keys"]>,
  renames: StormRename[],
): Promise<string[]> {
  const broken: string[] = [];
  const rowsOf = db.prepare(
    "SELECT version, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  );
  const linksOf = async (path: string, mark: number, field: "renamed_to" | "renamed_from") => {
    const pathHash = hashPathHex(keys.mac_key, path);
    const rows = rowsOf.all(vaultId, pathHash) as Array<{
      version: number;
      rename_mark: number;
      enc_metadata: Uint8Array;
    }>;
    const links: string[] = [];
    for (const row of rows) {
      if (row.rename_mark !== mark) continue;
      const meta = await decryptMetadata(row.enc_metadata, keys, pathHash).catch(() => null);
      if (meta?.[field]) links.push(meta[field]);
    }
    return links;
  };
  for (const { from, to } of renames) {
    const markers = await linksOf(from, RENAME_MARKER, "renamed_to");
    const notes = await linksOf(to, RENAME_NOTE, "renamed_from");
    if (markers.length !== 1 || markers[0] !== to) {
      broken.push(`marker on ${from}: ${JSON.stringify(markers)} want [${to}]`);
    }
    if (notes.length !== 1 || notes[0] !== from) {
      broken.push(`note on ${to}: ${JSON.stringify(notes)} want [${from}]`);
    }
  }
  return broken;
}

function trashCount(db: BenchDb, vaultId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?")
    .get(vaultId) as { n: number };
  return row.n;
}

function headOf(
  db: BenchDb,
  vaultId: string,
  plugin: TestPlugin,
  path: string,
): { version: number; deleted: number; rename_mark: number } | null {
  const row = db.prepare(
    "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version DESC LIMIT 1",
  ).get(vaultId, hashPathHex(plugin.keys!.mac_key, path)) as
    | { version: number; deleted: number; rename_mark: number }
    | undefined;
  return row ?? null;
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
