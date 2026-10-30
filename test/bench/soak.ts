// Soak (#587 item 5): a duration-bounded random storm between two devices on a
// throwaway server, seeded from a real vault copy. Each round mixes edits,
// creates, deletes, renames, cross-folder moves, folder moves and case-only
// renames on both devices, with a device paused/offline, plugin restarts and
// silent (event-less) renames mixed in; then it settles and runs the fuzz rename
// oracles plus the bench checks. A failing round prints its seed and round.
// NOT a *.test.ts. Reads the source vault READ-ONLY. Run:
//   GEODE_BENCH_VAULT_DIR=~/vaults/<your-vault> \
//     deno run -A --no-check test/bench/soak.ts --minutes 60 [--seed 1] [--ops 8]
import { pair, restartPlugin, type TestPlugin } from "../two-vault-driver.ts";
import {
  checkRenameConvergence,
  checkRenameHistoryLinks,
  checkRenameNoEditLost,
  checkRenameNoResurrected,
  type DeviceView,
  FuzzError,
  RenameBook,
  type RenameRecord,
  Rng,
  type TraceEntry,
} from "../fuzz/engine.ts";
import { hashPathHex } from "../../core/hash.ts";
import { isSyncable } from "../../plugin/plumbing/settings-types.ts";
import { isConflictPath } from "../../plugin/sync/conflicts.ts";
import {
  configCount,
  configVersions,
  mapsEqual,
  pushAndDrain,
  sampleBinaries,
  settle,
  trashedHashes,
  versionCount,
  walkFiles,
} from "./bench-helpers.ts";

const numberFlag = (name: string, fallback: number): number => {
  const i = Deno.args.indexOf(`--${name}`);
  const value = i >= 0 ? Number(Deno.args[i + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const MINUTES = numberFlag("minutes", 60);
const SEED = numberFlag("seed", 1);
const OPS = numberFlag("ops", 8);
/** Versions a round may add beyond one per op (a rename writes a marker + a note). */
const STORM_SLACK = 12;
const SYNCED_PLUGINS = ["obsidian-linter", "colored-text"];

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
const configFiles = allFiles.filter((f) => f.path.startsWith(".obsidian/"));
if (mdFiles.length === 0) {
  console.error(`no markdown files found under ${vaultDir}`);
  Deno.exit(2);
}

/** The op mix; `variant` is for the report only, the vault sees one rename. */
type Variant = "rename" | "move" | "case" | "folder";
type RenameOp = { kind: "rename"; order: number; from: string; to: string; variant: Variant };
type Op =
  | { kind: "create"; order: number; path: string; token: string }
  | { kind: "edit"; order: number; path: string; token: string }
  | { kind: "delete"; order: number; path: string }
  | RenameOp;

interface Ctx {
  dev: number;
  turn: number;
  /** The device's paths now, updated as this round's ops are generated. */
  live: Set<string>;
  /** Created or renamed-to this round: never a delete/rename source. */
  fresh: Set<string>;
}

interface Config {
  paths: string[];
  versions: number;
  count: number;
}

interface RoundStats {
  ops: number;
  edits: number;
  creates: number;
  deletes: number;
  renames: number;
  moves: number;
  folders: number;
  cases: number;
  silent: number;
  offlineRounds: number;
  restarts: number;
  versions: number;
  ms: number;
}

const zeroStats = (): RoundStats => ({
  ops: 0,
  edits: 0,
  creates: 0,
  deletes: 0,
  renames: 0,
  moves: 0,
  folders: 0,
  cases: 0,
  silent: 0,
  offlineRounds: 0,
  restarts: 0,
  versions: 0,
  ms: 0,
});

const paired = await pair();
const devices: TestPlugin[] = [paired.A, paired.B];
const { server, vaultId } = paired;
const db = server.db;
const rng = new Rng(SEED);
const book = new RenameBook();
const renames: RenameRecord[] = [];
/** Flush epoch: bumped after every push, so a rename and a delete share one only while
 * neither has been flushed (one debounce window). */
let flushEpoch = 0;
const trace: TraceEntry[] = [];
/** Path hashes this run deleted: the only names the trash may hold. */
const deleteHashes = new Set<string>();
let order = 0;
/** The seeded user file count: creates stop above it, so the tree stays vault-sized. */
let fileCap = 0;
const started = performance.now();
/** Where the current round's trace starts, so a failure can print just that round. */
let roundTraceStart = 0;

/** .obsidian is per-device scope; a restart resets the toggle, so re-apply it. */
function applyConfigScope(dev: TestPlugin): void {
  dev.pluginSettings.syncObsidianConfig = true;
  dev.pluginSettings.syncedPlugins = SYNCED_PLUGINS;
  dev.syncManager?.setSyncObsidianConfig(true);
}

/** The terminator keeps one token from being a substring of another. */
const tokenOf = (dev: number, at: number) => `SOAK-${dev}-${at};`;

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** "" at the vault root, otherwise with a trailing slash. */
const folderOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
};

/** The device's user files: conflict artifacts never carry rename links (#583 case 15). */
function userPaths(ctx: Ctx): string[] {
  return [...ctx.live].filter((p) =>
    !p.startsWith(".obsidian/") && !ctx.fresh.has(p) && !isConflictPath(p)
  );
}

function foldersOf(ctx: Ctx): string[] {
  return [...new Set(userPaths(ctx).map(folderOf).filter((f) => f !== ""))].sort();
}

function createOp(ctx: Ctx): Op {
  const folders = foldersOf(ctx);
  const folder = folders.length > 0 && rng.bool(0.7) ? rng.pick(folders) : "";
  const at = ++order;
  const path = `${folder}soak-${at}.md`;
  ctx.live.add(path);
  ctx.fresh.add(path);
  return { kind: "create", order: at, path, token: tokenOf(ctx.dev, at) };
}

/** A rename to `to` when nothing holds it, else to a name the op counter makes unique. */
function renameOp(ctx: Ctx, from: string, variant: Variant, to?: string): RenameOp {
  const at = ++order;
  const dest = to && !ctx.live.has(to) && !book.occupied.has(to)
    ? to
    : `${folderOf(from)}soak-${at} ${basenameOf(from)}`;
  ctx.live.delete(from);
  ctx.live.add(dest);
  ctx.fresh.add(dest);
  return { kind: "rename", order: at, from, to: dest, variant };
}

/** `Note.md` -> `NOTE.md`; null when the stem has no case to flip. */
function caseToggled(path: string): string | null {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const toggled = /[a-z]/.test(stem) ? stem.toUpperCase() : stem.toLowerCase();
  return toggled === stem ? null : `${folderOf(path)}${toggled}${dot > 0 ? name.slice(dot) : ""}`;
}

/** A whole folder moves with everything under it (one op per file). */
function folderMoveOp(ctx: Ctx, files: string[]): Op[] {
  const eligible = foldersOf(ctx).filter((folder) => {
    const n = files.filter((p) => p.startsWith(folder)).length;
    return n >= 2 && n <= 8;
  });
  if (eligible.length === 0) return [];
  const folder = rng.pick(eligible);
  const dest = `${folder.slice(0, -1)} (moved)/`;
  const moved = files.filter((p) => p.startsWith(folder));
  const taken = moved.some((p) =>
    ctx.live.has(dest + p.slice(folder.length)) || book.occupied.has(dest + p.slice(folder.length))
  );
  if (taken) return [];
  return moved.map((from) => {
    const at = ++order;
    const to = dest + from.slice(folder.length);
    ctx.live.delete(from);
    ctx.live.add(to);
    ctx.fresh.add(to);
    return { kind: "rename", order: at, from, to, variant: "folder" as const };
  });
}

/** One device's next op(s): the mix the issue asks for, weighted like the fuzz model. */
function planOp(ctx: Ctx): Op[] {
  const files = userPaths(ctx);
  const notes = files.filter((p) => p.endsWith(".md"));
  if (files.length === 0) return [createOp(ctx)];
  const from = rng.pick(files);
  const weight = rng.int(100);
  if (weight < 38 && notes.length > 0) {
    const at = ++order;
    return [{ kind: "edit", order: at, path: rng.pick(notes), token: tokenOf(ctx.dev, at) }];
  }
  if (weight < 60) {
    return files.length < fileCap
      ? [createOp(ctx)]
      : [{ kind: "delete", order: ++order, path: from }];
  }
  if (weight < 72) return [{ kind: "delete", order: ++order, path: from }];
  if (weight < 85) return [renameOp(ctx, from, "rename")];
  if (weight < 92) {
    const folders = foldersOf(ctx).filter((f) => f !== folderOf(from));
    if (folders.length === 0) return [renameOp(ctx, from, "rename")];
    return [renameOp(ctx, from, "move", rng.pick(folders) + basenameOf(from))];
  }
  if (weight < 96) {
    const pairs = files.flatMap((path) => {
      const to = caseToggled(path);
      return to !== null && !ctx.live.has(to) && !book.occupied.has(to) ? [{ path, to }] : [];
    });
    if (pairs.length === 0) return [renameOp(ctx, from, "rename")];
    const pair = rng.pick(pairs);
    return [renameOp(ctx, pair.path, "case", pair.to)];
  }
  const moved = folderMoveOp(ctx, files);
  return moved.length > 0 ? moved : [renameOp(ctx, from, "rename")];
}

function recordRename(
  ctx: Ctx,
  op: { order: number; from: string; to: string },
  silent = false,
): void {
  const sourceOpen = book.occupied.has(op.from);
  const destinationFree = !book.occupied.has(op.to);
  book.addRename(op.from, op.to, op.order, ctx.dev, ctx.turn);
  renames.push({
    from: op.from,
    to: op.to,
    order: op.order,
    dev: ctx.dev,
    turn: ctx.turn,
    sourceOpen,
    destinationFree,
    silent,
    epoch: flushEpoch,
  });
  trace.push({
    kind: "rn-rename",
    dev: ctx.dev,
    turn: ctx.turn,
    order: op.order,
    from: op.from,
    to: op.to,
    silent: silent || undefined,
  });
}

/** Apply one op; false when the vault drifted since the model was taken (a remote
 * apply moved or deleted the target) and the op must be skipped. */
async function applyOp(dev: TestPlugin, ctx: Ctx, op: Op): Promise<boolean> {
  if (op.kind === "create" || op.kind === "edit") {
    const existing = dev.fakeVault.files.get(op.path);
    if (op.kind === "create" && existing !== undefined) return false;
    // A note that vanished under us (a racing remote delete) is written fresh.
    const create = existing === undefined;
    const body = create
      ? `# soak\n\n${op.token}\n`
      : `${new TextDecoder().decode(existing)}\n${op.token}`;
    dev.fakeVault.write(op.path, body);
    if (create) book.addCreate(op.path);
    book.addEdit(ctx.dev, op.token, op.order, op.path);
    trace.push({
      kind: create ? "rn-create" : "rn-edit",
      dev: ctx.dev,
      turn: ctx.turn,
      order: op.order,
      path: op.path,
      token: op.token,
    });
    return true;
  }
  if (op.kind === "delete") {
    if (!dev.fakeVault.files.has(op.path)) return false;
    await dev.fakeVault.delete(op.path);
    // #629: the name a rename opened is deleted before either was pushed: the client
    // cancels the rename and writes one plain delete of the source, so the intent log
    // holds a delete (which a peer's racing edit may undo), not a rename-away, and the
    // trash entry is the source's, not the destination's (it never opened).
    const hop = renames.findLast((r) =>
      r.dev === ctx.dev && r.epoch === flushEpoch && r.to === op.path && r.order < op.order
    );
    if (hop) {
      book.cancelRename(hop.from, hop.to);
      deleteHashes.add(hashPathHex(dev.keys!.mac_key, hop.from));
    }
    book.addDelete(op.path, op.order);
    if (!hop) deleteHashes.add(hashPathHex(dev.keys!.mac_key, op.path));
    trace.push({ kind: "rn-delete", dev: ctx.dev, turn: ctx.turn, order: op.order, path: op.path });
    return true;
  }
  // Obsidian refuses a rename onto an existing path, so this op is a no-op then.
  if (!dev.fakeVault.files.has(op.from) || dev.fakeVault.files.has(op.to)) return false;
  dev.fakeVault.rename(op.from, op.to);
  recordRename(ctx, op);
  return true;
}

/**
 * A rename the event stream never sees (an OS-level move, a lost event): the
 * bytes move in the map and nothing fires, so only the reconciler can pair the
 * create with the delete (#583 PR 3).
 */
function silentRename(ctx: Ctx): boolean {
  const files = userPaths(ctx);
  if (files.length === 0) return false;
  const from = rng.pick(files);
  const bytes = devices[ctx.dev].fakeVault.files.get(from);
  if (!bytes) return false;
  const op = renameOp(ctx, from, "rename");
  if (devices[ctx.dev].fakeVault.files.has(op.to)) return false;
  const mtime = devices[ctx.dev].fakeVault.mtimes.get(from) ?? Date.now();
  devices[ctx.dev].fakeVault.files.delete(from);
  devices[ctx.dev].fakeVault.mtimes.delete(from);
  devices[ctx.dev].fakeVault.files.set(op.to, new Uint8Array(bytes));
  devices[ctx.dev].fakeVault.mtimes.set(op.to, mtime);
  recordRename(ctx, op, true);
  return true;
}

/** Push a device and start a new flush epoch: renames generated since the last push and a
 * delete now belong to one window (#629). */
async function push(dev: TestPlugin): Promise<void> {
  await pushAndDrain(dev);
  flushEpoch++;
}

/** Settle to true quiescence: one pass can end while a commit is still landing. */
async function settleQuiet(devs: TestPlugin[], label: string): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    if (await settle(devs, db, vaultId)) return;
  }
  throw new FuzzError(
    SEED,
    "settle-not-quiet",
    `${label}: the server kept growing across 10 settling passes`,
    trace,
  );
}

function ctxOf(dev: number, turn: number): Ctx {
  return { dev, turn, live: new Set(devices[dev].fakeVault.files.keys()), fresh: new Set() };
}

function views(): DeviceView[] {
  return devices.map((dev, i) => ({ label: `device-${i}`, files: dev.fakeVault.files }));
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function runRound(round: number, config: Config): Promise<RoundStats> {
  const stats = zeroStats();
  roundTraceStart = trace.length;
  const editStart = book.edits.length;
  const renameStart = renames.length;
  const versionsBefore = versionCount(db, vaultId);
  const clock = performance.now();

  // One device goes away mid-round: its ops are generated against the world as it
  // last saw it, so they land in a world that moved while it was gone.
  const offline = rng.bool(0.25) ? rng.int(devices.length) : -1;
  if (offline >= 0) {
    const mode = rng.bool(0.5) ? "pause" : "disconnect";
    if (mode === "pause") devices[offline].pause();
    else devices[offline].disconnect();
    trace.push({ kind: "rn-offline", dev: offline, turn: round, mode });
    stats.offlineRounds++;
  }

  // A guaranteed race: one device edits the note the other renames, in the same
  // window: the sequence #583's review found hand-written tests had missed.
  if (rng.bool(0.4)) {
    const editor = rng.int(devices.length);
    const renamer = devices.length - 1 - editor;
    const notes = userPaths(ctxOf(editor, round)).filter((p) => p.endsWith(".md"));
    if (notes.length > 0) {
      const path = rng.pick(notes);
      const at = ++order;
      const edited = await applyOp(devices[editor], ctxOf(editor, round), {
        kind: "edit",
        order: at,
        path,
        token: tokenOf(editor, at),
      });
      const ctx = ctxOf(renamer, round);
      const renamed = await applyOp(devices[renamer], ctx, renameOp(ctx, path, "rename"));
      stats.ops += Number(edited) + Number(renamed);
      if (edited) stats.edits++;
      if (renamed) stats.renames++;
    }
  }

  for (const dev of shuffle(devices.map((_, i) => i))) {
    const ctx = ctxOf(dev, round);
    for (let k = 0; k < OPS; k++) {
      for (const op of planOp(ctx)) {
        if (!await applyOp(devices[dev], ctx, op)) continue;
        stats.ops++;
        if (op.kind === "create") stats.creates++;
        else if (op.kind === "edit") stats.edits++;
        else if (op.kind === "delete") stats.deletes++;
        else {
          stats.renames++;
          if (op.variant === "move") stats.moves++;
          else if (op.variant === "folder") stats.folders++;
          else if (op.variant === "case") stats.cases++;
        }
      }
    }
  }

  const online = devices.map((_, i) => i).filter((i) => i !== offline);
  // Push both at once: sequencing them would let the second device commit against
  // a server that already absorbed the first, hiding real races.
  await Promise.all(online.map((dev) => push(devices[dev])));
  await settleQuiet(online.map((i) => devices[i]), `round ${round} online`);
  if (offline >= 0) {
    await devices[offline].resume();
    await push(devices[offline]);
    await settleQuiet(devices, `round ${round} resume`);
  }

  if (rng.bool(0.2)) {
    const dev = rng.int(devices.length);
    devices[dev] = await restartPlugin(devices[dev], server);
    applyConfigScope(devices[dev]);
    trace.push({ kind: "rn-restart", dev, turn: round });
    stats.restarts++;
    await settleQuiet(devices, `round ${round} restart`);
  }

  if (rng.bool(0.12)) {
    const ctx = ctxOf(rng.int(devices.length), round);
    if (silentRename(ctx)) {
      stats.silent++;
      await push(devices[ctx.dev]);
      await settleQuiet(devices, `round ${round} silent`);
    }
  }

  stats.versions = versionCount(db, vaultId) - versionsBefore;
  stats.ms = Math.round(performance.now() - clock);

  const v = views();
  checkRenameConvergence(v, SEED, trace);
  checkRenameNoResurrected(v, book, renames, SEED, trace);
  checkRenameNoEditLost(v, book, SEED, trace, book.edits.slice(editStart));
  // A storm: more versions than the ops can explain.
  const bound = 2 * stats.ops + STORM_SLACK;
  if (stats.versions > bound) {
    throw new FuzzError(
      SEED,
      "version-storm",
      `round ${round}: ${stats.versions} versions for ${stats.ops} ops (bound ${bound})`,
      trace,
    );
  }
  const roundRenames = renames.slice(renameStart);
  if (roundRenames.length > 0) {
    await checkRenameHistoryLinks(db, vaultId, devices[0].keys!, roundRenames, SEED, trace);
  }
  await checkConfig(config);
  checkTrash();
  await checkNoStorm(round);
  return stats;
}

/** `.obsidian` holds only what the seed put there: a storm would churn its rows. */
function checkConfig(config: Config): void {
  const rows = configVersions(db, vaultId, devices[0].keys!, config.paths);
  const counts = devices.map((dev) => configCount(dev.fakeVault.files));
  if (rows !== config.versions || counts.some((n) => n !== config.count)) {
    throw new FuzzError(
      SEED,
      "obsidian-config-drift",
      `config version rows ${config.versions} -> ${rows}; ` +
        `config files ${counts.join("/")} want ${config.count}`,
      trace,
    );
  }
}

/** Trash holds deletions only: a rename closes a name without trashing it. */
function checkTrash(): void {
  const stray = [...trashedHashes(db, vaultId)].filter((hash) => !deleteHashes.has(hash));
  if (stray.length > 0) {
    throw new FuzzError(
      SEED,
      "trash-not-a-delete",
      `${stray.length} trashed head(s) with no delete behind them: ` +
        stray.slice(0, 5).map((h) => h.slice(0, 12)).join(", "),
      trace,
    );
  }
}

/** An extra settle must add nothing: a storm would keep the server growing. */
async function checkNoStorm(round: number): Promise<void> {
  const before = versionCount(db, vaultId);
  await settleQuiet(devices, `round ${round} storm`);
  const after = versionCount(db, vaultId);
  if (after !== before) {
    throw new FuzzError(
      SEED,
      "settle-storm",
      `round ${round}: an extra settle added ${after - before} versions (${before} -> ${after})`,
      trace,
    );
  }
}

/** Every row and local file behind a divergence, so a failure is reportable as-is. */
function dumpDivergence(): void {
  const cmp = mapsEqual(devices[0].fakeVault.files, devices[1].fakeVault.files);
  if (cmp.equal) return;
  console.error(`\ndivergent paths (${cmp.diff.length}):`);
  const rowsOf = db.prepare(
    "SELECT version, seq, deleted, rename_mark, device_id FROM file_versions " +
      "WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  );
  for (const line of cmp.diff.slice(0, 10)) {
    const path = line.replace(/^(missing in A|missing in B|content mismatch): /, "");
    console.error(`\n  ${line}`);
    console.error(
      `    on disk: A=${devices[0].fakeVault.files.has(path)} B=${
        devices[1].fakeVault.files.has(path)
      }` +
        ` | intent: away=${book.renamedAway.has(path)} occupied=${book.occupied.has(path)}`,
    );
    const hash = hashPathHex(devices[0].keys!.mac_key, path);
    const rows = rowsOf.all(vaultId, hash) as Array<
      { version: number; seq: number; deleted: number; rename_mark: number; device_id: string }
    >;
    console.error(`    server rows: ${rows.length === 0 ? "none" : JSON.stringify(rows)}`);
    for (const [i, dev] of devices.entries()) {
      const row = dev.state?.getLocalFile(path);
      console.error(
        `    device-${i} state: ${
          row
            ? `last_seen=${row.last_seen_version} deleted=${row.deleted} size=${row.size}`
            : "none"
        }`,
      );
    }
  }
}

function report(round: number, stats: RoundStats): void {
  console.log(
    `round ${round} | ops ${stats.ops} (e${stats.edits} c${stats.creates} d${stats.deletes} ` +
      `r${stats.renames} [move${stats.moves} folder${stats.folders} case${stats.cases} ` +
      `silent${stats.silent}]) ` +
      `| offline ${stats.offlineRounds} restart ${stats.restarts} ` +
      `| +${stats.versions} v | ${stats.ms}ms ` +
      `| files ${devices[0].fakeVault.files.size}/${devices[1].fakeVault.files.size}`,
  );
}

async function seed(): Promise<Config> {
  for (const f of [...mdFiles, ...binSample]) devices[0].fakeVault.writeBinary(f.path, f.data);
  await push(devices[0]);
  await settleQuiet(devices, "seed");
  // .obsidian discovery needs the toggle on both devices; the config files go
  // straight into the map, so only the reconciler's scan can find them.
  for (const dev of devices) applyConfigScope(dev);
  for (const f of configFiles) {
    if (isSyncable(f.path, ".obsidian", devices[0].pluginSettings)) {
      devices[0].fakeVault.files.set(f.path, new Uint8Array(f.data));
    }
  }
  await push(devices[0]);
  await settleQuiet(devices, "seed config");
  for (const path of devices[0].fakeVault.files.keys()) {
    if (!path.startsWith(".obsidian/") && !isConflictPath(path)) book.addCreate(path);
  }
  const paths = [...devices[0].fakeVault.files.keys()].filter((p) => p.startsWith(".obsidian/"));
  const config = {
    paths,
    versions: configVersions(db, vaultId, devices[0].keys!, paths),
    count: configCount(devices[0].fakeVault.files),
  };
  checkRenameConvergence(views(), SEED, trace);
  console.log(
    `seeded: ${devices[0].fakeVault.files.size} files on A (${config.count} .obsidian), ` +
      `${versionCount(db, vaultId)} versions`,
  );
  return config;
}

try {
  console.log(
    `soak: seed=${SEED} minutes=${MINUTES} ops/device/round=${OPS} vault="${vaultDir}" ` +
      `(${mdFiles.length} md + ${binSample.length} binaries)`,
  );
  const config = await seed();
  fileCap = [...devices[0].fakeVault.files.keys()].filter((p) =>
    !p.startsWith(".obsidian/")
  ).length;
  const deadline = started + MINUTES * 60_000;
  const totals = zeroStats();
  let rounds = 0;
  for (let round = 0; performance.now() < deadline; round++) {
    const stats = await runRound(round, config);
    report(round, stats);
    rounds++;
    for (const key of Object.keys(totals) as (keyof RoundStats)[]) totals[key] += stats[key];
  }

  // Whole-run oracles: convergence, no name back, and the history of every rename.
  checkTrash();
  checkRenameConvergence(views(), SEED, trace);
  checkRenameNoResurrected(views(), book, renames, SEED, trace);
  await checkRenameHistoryLinks(db, vaultId, devices[0].keys!, renames, SEED, trace);
  const conflicts = [...devices[0].fakeVault.files.keys()].filter(isConflictPath).length;
  const wall = (performance.now() - started) / 60_000;
  console.log(
    `\nSOAK PASS seed=${SEED}: ${rounds} rounds, ${totals.ops} ops ` +
      `(e${totals.edits} c${totals.creates} d${totals.deletes} r${totals.renames} ` +
      `[move${totals.moves} folder${totals.folders} case${totals.cases} silent${totals.silent}]), ` +
      `${totals.offlineRounds} offline + ${totals.restarts} restart rounds, ` +
      `${renames.length} renames linked, ${conflicts} conflict files, ` +
      `${versionCount(db, vaultId)} server versions, trash ${trashedHashes(db, vaultId).size}, ` +
      `${wall.toFixed(1)}min`,
  );
  Deno.exit(0);
} catch (error) {
  if (error instanceof FuzzError) {
    console.error(
      `\nSOAK FAIL seed=${SEED} invariant="${error.invariant}"\n${error.details}\n` +
        `ops of the failing round:\n` +
        error.opTrace.slice(roundTraceStart).map((e) => JSON.stringify(e)).join("\n") +
        `\n\nreproduce: --seed ${SEED} (the round above is printed last on stdout)`,
    );
    if (error.invariant === "rename-convergence") await dumpDivergence();
  } else {
    console.error(`\nSOAK FAIL seed=${SEED} (harness):`, error);
  }
  Deno.exit(1);
}
