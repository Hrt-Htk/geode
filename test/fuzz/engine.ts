// Fuzz engine: turn-based single writer + chaos injection, concurrent
// divergent-edit runners, and concurrent rename fuzz (#587).
//
// M2a (issue #113): compact op traces, chaos injection (restart /
// disconnect-reconnect), and a quarantine scaffold for known-failure signatures.
// M2b: concurrent divergent-edit / binary / 3-device runners, and the concurrent
// rename runner (2-3 devices renaming, moving folders, editing and deleting at
// the same time) with rename oracles (#587).

import { arraysEqual } from "../helpers/bytes.ts";
import {
  pair,
  restartPlugin,
  type TestPlugin,
  type TestServer,
  triple,
} from "../two-vault-driver.ts";
import { isMarkdownPath, normalizeMarkdownLineEndings } from "../../core/normalize.ts";
import { hashPathHex } from "../../core/hash.ts";
import { decryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { isConflictPath } from "../../plugin/sync/conflicts.ts";
import { RENAME_MARKER, RENAME_NOTE } from "../../core/protocol.ts";

// ── Seeded PRNG (Mulberry32) ───────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s |= 0;
    s = (s + 0x6c62272e) | 0;
    let t = Math.imul(s ^ (s >>> 16), 0x76d16911);
    t = (t + Math.imul(t & 0xffff, 0x3243b984)) ^ t;
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  nextU32(): number {
    // Use >>> 0 for unsigned 32-bit (| 0 can produce negative values)
    return (this.next() * 0x100000000) >>> 0;
  }

  int(maxExclusive: number): number {
    return this.nextU32() % maxExclusive;
  }

  float(): number {
    return this.next();
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)];
  }

  bool(prob = 0.5): boolean {
    return this.float() < prob;
  }

  bytes(len: number): Uint8Array {
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = this.nextU32() & 0xff;
    }
    return buf;
  }
}

// ── Content Corpus ─────────────────────────────────────────────────────

const MARKER_LINE_A = "<<<<<<<";
const MARKER_LINE_B = "=======";
const MARKER_LINE_C = ">>>>>>>";

interface ContentItem {
  bytes: Uint8Array;
  isBinary: boolean;
}

export function makeContent(rng: Rng): ContentItem {
  const kind = rng.int(8);
  switch (kind) {
    case 0: // empty
      return { bytes: new Uint8Array(0), isBinary: false };
    case 1: // whitespace only
      return {
        bytes: new TextEncoder().encode("   \n  \t  \n   "),
        isBinary: false,
      };
    case 2: // short text
      return {
        bytes: new TextEncoder().encode(`short-${rng.nextU32().toString(16)}`),
        isBinary: false,
      };
    case 3: // multi-line text
    {
      const lines = 3 + rng.int(20);
      const text = Array.from(
        { length: lines },
        () => `line-${rng.nextU32().toString(16)}-${rng.int(1000)}`,
      ).join("\n");
      return { bytes: new TextEncoder().encode(text), isBinary: false };
    }
    case 4: // unicode / emoji
    {
      const emojis = ["🔥", "🎉", "🐛", "📦", "✅", "🌍", "🔑", "🧪"];
      const text = Array.from(
        { length: 10 },
        () => `${rng.pick(emojis)} unicode-${rng.nextU32().toString(16)} café naïve 日本語`,
      ).join("\n");
      return { bytes: new TextEncoder().encode(text), isBinary: false };
    }
    case 5: // content with conflict markers (deliberate)
    {
      const text = [
        `before marker ${rng.nextU32().toString(16)}`,
        MARKER_LINE_A,
        `modified content A-${rng.nextU32().toString(16)}`,
        MARKER_LINE_B,
        `modified content B-${rng.nextU32().toString(16)}`,
        MARKER_LINE_C,
        `after marker ${rng.nextU32().toString(16)}`,
      ].join("\n");
      return { bytes: new TextEncoder().encode(text), isBinary: false };
    }
    case 6: // large text blob (~256 KB)
    {
      const size = 256 * 1024;
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        buf[i] = rng.nextU32() & 0x7f; // printable-ish
      }
      return { bytes: buf, isBinary: false };
    }
    case 7: // random binary
      return { bytes: rng.bytes(256 + rng.int(4096)), isBinary: true };
  }
  return { bytes: new Uint8Array(0), isBinary: false };
}

// ── Op Model ───────────────────────────────────────────────────────────

export type Op =
  | { kind: "create"; path: string; content: Uint8Array }
  | { kind: "modify"; path: string; content: Uint8Array }
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string };

// ── Compact trace descriptors ──────────────────────────────────────────
//
// FuzzError used to embed raw content bytes in its op trace, which floods
// output on the large/binary corpus. The seed reproduces exact bytes
// deterministically, so a compact descriptor { kind, path, len, tag } is
// enough to identify and replay a failing sequence.

export type TraceEntry =
  | { kind: "create"; path: string; len: number; tag: string }
  | { kind: "modify"; path: string; len: number; tag: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "chaos"; device: "A" | "B"; mode: "restart" | "reconnect"; turn: number }
  | { kind: "concurrent"; path: string; turn: number }
  | { kind: "concurrent-binary"; path: string; turn: number }
  | { kind: "triple"; path: string; turn: number; writers: string }
  | {
    kind: "rn-create" | "rn-edit";
    dev: number;
    turn: number;
    order: number;
    path: string;
    token: string;
  }
  | { kind: "rn-delete"; dev: number; turn: number; order: number; path: string }
  | {
    kind: "rn-rename";
    dev: number;
    turn: number;
    order: number;
    from: string;
    to: string;
    folder?: string;
    silent?: boolean;
  }
  | { kind: "rn-offline" | "rn-online" | "rn-restart"; dev: number; turn: number; mode?: string };

/** Short human-readable classification of content bytes for the trace. */
function contentTag(path: string, content: Uint8Array): string {
  if (content.length === 0) return "empty";
  if (!isMarkdownPath(path)) return "binary";
  const text = new TextDecoder().decode(content);
  if (text.trim().length === 0) return "whitespace";
  const lines = text.split("\n");
  if (
    lines.includes(MARKER_LINE_A) &&
    lines.includes(MARKER_LINE_B) &&
    lines.includes(MARKER_LINE_C)
  ) {
    return "markers";
  }
  if (content.length >= 64 * 1024) return "large-text";
  // deno-lint-ignore no-control-regex
  if (/[^\x00-\x7f]/.test(text)) return "unicode";
  if (lines.length > 1) return "multiline";
  return "text";
}

/** Compress a real Op into a compact trace descriptor. */
export function toTraceEntry(op: Op): TraceEntry {
  switch (op.kind) {
    case "create":
    case "modify":
      return {
        kind: op.kind,
        path: op.path,
        len: op.content.length,
        tag: contentTag(op.path, op.content),
      };
    case "delete":
      return { kind: "delete", path: op.path };
    case "rename":
      return { kind: "rename", from: op.from, to: op.to };
  }
}

/** Generate a path for a new file. */
function makeNewPath(rng: Rng, isBinary: boolean): string {
  const folder = rng.bool(0.15) ? `folder-${rng.nextU32().toString(16)}/` : "";
  const name = `file-${rng.nextU32().toString(16)}`;
  const ext = isBinary ? ".bin" : ".md";
  return `${folder}${name}${ext}`;
}

/** Generate a random op given the current oracle state. */
export function makeOp(
  rng: Rng,
  oracle: Map<string, Uint8Array>,
  /** Paths created earlier this turn: don't delete them. */
  newlyCreatedThisTurn: Set<string>,
): Op {
  const existingPaths = [...oracle.keys()];
  const weight = rng.int(100);

  if (weight < 10) {
    // ~10% rename: pick an existing path, generate fresh target
    if (existingPaths.length === 0) {
      const content = makeContent(rng);
      const path = makeNewPath(rng, content.isBinary);
      return { kind: "create", path, content: content.bytes };
    }
    const renamablePaths = existingPaths.filter((p) => !newlyCreatedThisTurn.has(p));
    if (renamablePaths.length === 0) {
      const content = makeContent(rng);
      const path = makeNewPath(rng, content.isBinary);
      return { kind: "create", path, content: content.bytes };
    }
    const from = rng.pick(renamablePaths);
    const isBinary = !isMarkdownPath(from);
    const to = makeNewPath(rng, isBinary);
    return { kind: "rename", from, to };
  } else if (weight < 65) {
    // ~55% modify existing
    if (existingPaths.length === 0) {
      const content = makeContent(rng);
      const path = makeNewPath(rng, content.isBinary);
      return { kind: "create", path, content: content.bytes };
    }
    const path = rng.pick(existingPaths);
    const content = makeContent(rng);
    return { kind: "modify", path, content: content.bytes };
  } else if (weight < 78) {
    // ~13% create
    const content = makeContent(rng);
    const path = makeNewPath(rng, content.isBinary);
    return { kind: "create", path, content: content.bytes };
  } else if (weight < 88) {
    // ~10% delete: skip files created this turn
    if (existingPaths.length === 0) {
      const content = makeContent(rng);
      const path = makeNewPath(rng, content.isBinary);
      return { kind: "create", path, content: content.bytes };
    }
    const deletablePaths = existingPaths.filter((p) => !newlyCreatedThisTurn.has(p));
    if (deletablePaths.length === 0) {
      const content = makeContent(rng);
      const path = makeNewPath(rng, content.isBinary);
      return { kind: "create", path, content: content.bytes };
    }
    const path = rng.pick(deletablePaths);
    return { kind: "delete", path };
  } else {
    // ~12% create in new folder
    const content = makeContent(rng);
    const folder = `newfolder-${rng.nextU32().toString(16)}/`;
    const name = `file-${rng.nextU32().toString(16)}`;
    const ext = content.isBinary ? ".bin" : ".md";
    const path = `${folder}${name}${ext}`;
    return { kind: "create", path, content: content.bytes };
  }
}

// ── Oracle Model ───────────────────────────────────────────────────────

/** Apply an op to both the device's fakeVault and the oracle model. */
export function applyOp(
  writer: TestPlugin,
  oracle: Map<string, Uint8Array>,
  markerPaths: Set<string>,
  op: Op,
): void {
  switch (op.kind) {
    case "create":
    case "modify": {
      const content = op.content;
      const normalized = isMarkdownPath(op.path)
        ? new TextEncoder().encode(
          normalizeMarkdownLineEndings(new TextDecoder().decode(content)),
        )
        : new Uint8Array(content);

      writer.fakeVault.writeBinary(op.path, content);
      oracle.set(op.path, normalized);

      if (isMarkdownPath(op.path)) {
        const text = new TextDecoder().decode(normalized);
        const lines = text.split("\n");
        if (
          lines.includes(MARKER_LINE_A) &&
          lines.includes(MARKER_LINE_B) &&
          lines.includes(MARKER_LINE_C)
        ) {
          markerPaths.add(op.path);
        }
      }
      break;
    }
    case "delete": {
      writer.fakeVault.delete(op.path);
      oracle.delete(op.path);
      break;
    }
    case "rename": {
      const oldContent = oracle.get(op.from);
      if (oldContent) {
        const normalized = isMarkdownPath(op.to)
          ? new TextEncoder().encode(
            normalizeMarkdownLineEndings(new TextDecoder().decode(oldContent)),
          )
          : new Uint8Array(oldContent);

        oracle.delete(op.from);
        oracle.set(op.to, normalized);

        // Update marker tracking for the new path
        if (isMarkdownPath(op.to)) {
          const text = new TextDecoder().decode(normalized);
          const lines = text.split("\n");
          if (
            lines.includes(MARKER_LINE_A) &&
            lines.includes(MARKER_LINE_B) &&
            lines.includes(MARKER_LINE_C)
          ) {
            markerPaths.add(op.to);
          }
        }
        markerPaths.delete(op.from);
      } else {
        oracle.delete(op.from);
      }

      writer.fakeVault.rename(op.from, op.to);
      break;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function mapsEqual(
  a: Map<string, Uint8Array>,
  b: Map<string, Uint8Array>,
): { equal: boolean; diff?: string } {
  const aKeys = new Set(a.keys());
  const bKeys = new Set(b.keys());

  if (aKeys.size !== bKeys.size) {
    return { equal: false, diff: `key count: a=${aKeys.size} b=${bKeys.size}` };
  }

  for (const key of aKeys) {
    if (!bKeys.has(key)) {
      return { equal: false, diff: `key missing in b: ${key}` };
    }
    if (!arraysEqual(a.get(key)!, b.get(key)!)) {
      return { equal: false, diff: `content mismatch: ${key}` };
    }
  }

  return { equal: true };
}

/** Up to 8 differing paths between two vaults, for a settle/divergence message. */
function describeDiff(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string {
  const diffs: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const da = a.get(key);
    const db = b.get(key);
    if (da && db && arraysEqual(da, db)) continue;
    diffs.push(`${key}[${da ? "a" : "-"}${db ? "b" : "-"}]`);
  }
  return diffs.slice(0, 8).join(" ") + (diffs.length > 8 ? ` (+${diffs.length - 8})` : "");
}

// ── FuzzError ──────────────────────────────────────────────────────────

export class FuzzError extends Error {
  constructor(
    public readonly seed: number,
    public readonly invariant: string,
    public readonly details: string,
    public readonly opTrace: TraceEntry[],
  ) {
    super(
      `FuzzError [seed=${seed}] invariant="${invariant}": ${details}\n` +
        `Op trace (${opTrace.length} entries):\n${JSON.stringify(opTrace)}`,
    );
    this.name = "FuzzError";
  }
}

// ── Invariant Checks ───────────────────────────────────────────────────

function checkMarkerLeakage(
  files: Map<string, Uint8Array>,
  markerPaths: Set<string>,
): string | null {
  const decoder = new TextDecoder();
  for (const [path, data] of files) {
    if (!isMarkdownPath(path)) continue;
    if (markerPaths.has(path)) continue;

    const text = decoder.decode(data);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line === MARKER_LINE_A || line === MARKER_LINE_B || line === MARKER_LINE_C) {
        return `merge marker found in ${path} (not a seeded marker path)`;
      }
    }
  }
  return null;
}

function checkConflictFiles(
  files: Map<string, Uint8Array>,
): string | null {
  for (const path of files.keys()) {
    if (/\b\.conflict\b/.test(path) || path.includes(" (conflict ")) {
      return `conflict file found: ${path}`;
    }
  }
  return null;
}

type DbHandle = ReturnType<typeof import("../../server/db.ts").openDb>;

function checkSeqMonotonic(db: DbHandle, vaultId: string): string | null {
  const rows = db.prepare(
    "SELECT seq FROM file_versions WHERE vault_id = ? ORDER BY seq",
  ).all(vaultId) as Array<{ seq: number }>;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].seq <= rows[i - 1].seq) {
      return `seq not strictly increasing: seq[${i - 1}]=${rows[i - 1].seq} >= seq[${i}]=${
        rows[i].seq
      }`;
    }
  }

  const seqSet = new Set(rows.map((r) => r.seq));
  if (seqSet.size !== rows.length) {
    return `duplicate seq values found (${rows.length} rows, ${seqSet.size} unique)`;
  }

  return null;
}

export function checkInvariants(
  A: TestPlugin,
  B: TestPlugin,
  oracle: Map<string, Uint8Array>,
  markerPaths: Set<string>,
  db: DbHandle,
  vaultId: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  const conv = mapsEqual(A.fakeVault.files, B.fakeVault.files);
  if (!conv.equal) {
    throw new FuzzError(seed, "convergence", `A and B diverged: ${conv.diff}`, opTrace);
  }

  const aOracle = mapsEqual(A.fakeVault.files, oracle);
  if (!aOracle.equal) {
    throw new FuzzError(seed, "oracle-A", `A does not match oracle: ${aOracle.diff}`, opTrace);
  }

  const bOracle = mapsEqual(B.fakeVault.files, oracle);
  if (!bOracle.equal) {
    throw new FuzzError(seed, "oracle-B", `B does not match oracle: ${bOracle.diff}`, opTrace);
  }

  const markerA = checkMarkerLeakage(A.fakeVault.files, markerPaths);
  if (markerA) {
    throw new FuzzError(seed, "marker-leakage-A", markerA, opTrace);
  }
  const markerB = checkMarkerLeakage(B.fakeVault.files, markerPaths);
  if (markerB) {
    throw new FuzzError(seed, "marker-leakage-B", markerB, opTrace);
  }

  const conflictA = checkConflictFiles(A.fakeVault.files);
  if (conflictA) {
    throw new FuzzError(seed, "conflict-file-A", conflictA, opTrace);
  }
  const conflictB = checkConflictFiles(B.fakeVault.files);
  if (conflictB) {
    throw new FuzzError(seed, "conflict-file-B", conflictB, opTrace);
  }

  const seqErr = checkSeqMonotonic(db, vaultId);
  if (seqErr) {
    throw new FuzzError(seed, "seq-monotonic", seqErr, opTrace);
  }
}

// ── Run Sequence ───────────────────────────────────────────────────────

export interface ChaosOpts {
  /** Per-turn probability of injecting chaos on the just-finished writer. */
  probability: number;
  /** Enable restartPlugin chaos (fresh in-memory state, preserved disk). */
  restart: boolean;
  /** Enable disconnect/reconnect chaos around a turn boundary. */
  reconnect: boolean;
}

export interface RunSequenceOpts {
  seed: number;
  turns: number;
  opsPerTurn: number;
  /** Optional seeded chaos injection. Omit for M1-equivalent behavior. */
  chaos?: ChaosOpts;
}

/**
 * Apply ops one at a time with a mini-sync between each.
 *
 * Why: the event handler queues create + delete events synchronously,
 * but the async commit chain (read → chunk → encrypt → upload → state
 * upsert) for a create may not complete before the delete's commit runs.
 * Applying one op at a time with a flush between them avoids this race.
 */
async function applyOpsOneByOne(
  writer: TestPlugin,
  rng: Rng,
  oracle: Map<string, Uint8Array>,
  markerPaths: Set<string>,
  newlyCreatedThisTurn: Set<string>,
  opsPerTurn: number,
  opTrace: TraceEntry[],
  throwIfRejected: (opTrace: TraceEntry[]) => void,
): Promise<void> {
  for (let i = 0; i < opsPerTurn; i++) {
    const op = makeOp(rng, oracle, newlyCreatedThisTurn);
    applyOp(writer, oracle, markerPaths, op);
    opTrace.push(toTraceEntry(op));
    if (op.kind === "create") {
      newlyCreatedThisTurn.add(op.path);
    }
    if (op.kind === "rename") {
      newlyCreatedThisTurn.add(op.to);
    }

    // Mini-sync after each op so the async commit chain completes
    // before the next op's events fire.
    await writer.pushNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected([...opTrace]);
  }
}

/** Settle to quiescence: loop reconcile until server version count stops changing. */
async function settle(
  db: DbHandle,
  vaultId: string,
  A: TestPlugin,
  B: TestPlugin,
  maxRounds: number,
  seed: number,
  opTrace: TraceEntry[],
  throwIfRejected: (opTrace: TraceEntry[]) => void,
): Promise<void> {
  let prevCount = -1;
  for (let round = 0; round < maxRounds; round++) {
    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected([...opTrace]);

    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };
    const count = row.n;

    if (count === prevCount) {
      // A stable version count is not enough: a device may still be applying.
      const { s } = db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM file_versions WHERE vault_id = ?",
      ).get(vaultId) as { s: number };
      await A.waitForCaughtUp(s);
      await B.waitForCaughtUp(s);
      const after = db.prepare(
        "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
      ).get(vaultId) as { n: number };
      if (after.n === count) return;
    }
    prevCount = count;
  }

  throw new FuzzError(
    seed,
    "settle-non-termination",
    `did not settle after ${maxRounds} rounds (final version count: ${prevCount})`,
    opTrace,
  );
}

/**
 * Inject seeded chaos on the just-finished writer, preserving single-writer
 * structure. Returns the (possibly new) plugin instance to use going forward.
 *
 * - restart: uses restartPlugin(), which STOPS `plugin` and returns a NEW
 *   TestPlugin with fresh in-memory state but preserved FakeVault disk +
 *   persistedLocalFiles. The caller MUST adopt the returned instance.
 * - reconnect: disconnect() then reconnect() around the turn boundary; the
 *   same instance is returned.
 *
 * With a single writer the vault must STILL fully converge across a restart or
 * reconnect, so the strong invariants stay valid; any violation here is a real
 * restart/replay/data-loss bug.
 */
async function injectChaos(
  plugin: TestPlugin,
  device: "A" | "B",
  turn: number,
  chaos: ChaosOpts,
  rng: Rng,
  server: { url: string },
  opTrace: TraceEntry[],
): Promise<TestPlugin> {
  const modes: Array<"restart" | "reconnect"> = [];
  if (chaos.restart) modes.push("restart");
  if (chaos.reconnect) modes.push("reconnect");
  if (modes.length === 0) return plugin;

  const mode = rng.pick(modes);
  opTrace.push({ kind: "chaos", device, mode, turn });

  if (mode === "restart") {
    return await restartPlugin(plugin, server);
  }
  // reconnect
  plugin.disconnect();
  await new Promise((r) => setTimeout(r, 0));
  await plugin.reconnect();
  return plugin;
}

export async function runSequence(opts: RunSequenceOpts): Promise<void> {
  const rng = new Rng(opts.seed);
  const oracle = new Map<string, Uint8Array>();
  const markerPaths = new Set<string>();
  const opTrace: TraceEntry[] = [];

  // --- Background-rejection trap ---
  // Catches async rejections from the reconciler (e.g. commitOp, handleConflict)
  // so a discovered bug fails its own seed cleanly instead of crashing the runner.
  let backgroundRejection: unknown = null;
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    if (backgroundRejection == null) backgroundRejection = e.reason;
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  // Throw a FuzzError if a background rejection was captured.
  const throwIfRejected = (trace: TraceEntry[]) => {
    if (backgroundRejection != null) {
      const msg = backgroundRejection instanceof Error
        ? (backgroundRejection.stack ?? backgroundRejection.message)
        : String(backgroundRejection);
      throw new FuzzError(opts.seed, "background-rejection", String(msg), trace);
    }
  };

  const paired = await pair();
  const { server, vaultId } = paired;
  // Mutable refs: restart chaos swaps in a NEW TestPlugin instance, so A/B
  // cannot be const: a stale reference would drive a dead plugin.
  let A = paired.A;
  let B = paired.B;

  try {
    for (let turn = 0; turn < opts.turns; turn++) {
      const writerIsA = turn % 2 === 0;
      const writer = writerIsA ? A : B;
      const newlyCreatedThisTurn = new Set<string>();

      // Apply ops one at a time with mini-sync between each
      await applyOpsOneByOne(
        writer,
        rng,
        oracle,
        markerPaths,
        newlyCreatedThisTurn,
        opts.opsPerTurn,
        opTrace,
        throwIfRejected,
      );

      // Full settle: ensure both devices are fully synced
      await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);

      // Chaos injection (single-writer preserved): between turns, with seeded
      // probability, restart or disconnect/reconnect the writer. Re-settle
      // afterward before checking invariants: the vault must still converge.
      if (opts.chaos && rng.bool(opts.chaos.probability)) {
        const device: "A" | "B" = writerIsA ? "A" : "B";
        const next = await injectChaos(
          writer,
          device,
          turn,
          opts.chaos,
          rng,
          server,
          opTrace,
        );
        if (writerIsA) A = next;
        else B = next;
        throwIfRejected(opTrace);
        await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);
      }

      // Check invariants
      checkInvariants(A, B, oracle, markerPaths, server.db, vaultId, opts.seed, opTrace);
    }

    // No-op resync: record server version count, do one more full settle with no new ops,
    // assert count is unchanged and files still equal and no new .conflict paths.
    const preResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected(opTrace);

    const postResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    if (preResyncCount.n !== postResyncCount.n) {
      throw new FuzzError(
        opts.seed,
        "no-op-resync-version-count",
        `version count changed during no-op resync: ${preResyncCount.n} -> ${postResyncCount.n}`,
        opTrace,
      );
    }

    checkInvariants(A, B, oracle, markerPaths, server.db, vaultId, opts.seed, opTrace);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    // Stop the CURRENT A/B (restart may have replaced them) then the server.
    try {
      A.stop();
    } catch { /* already stopped */ }
    try {
      B.stop();
    } catch { /* already stopped */ }
    await server.stop();
  }
}

// ── Quarantine scaffold ────────────────────────────────────────────────
//
// A sweep can quarantine a KNOWN, already-triaged product bug so it doesn't
// halt discovery of *other* bugs. A caught FuzzError is quarantined ONLY if it
// matches a signature in KNOWN_FAILURES (invariant name + a substring that must
// appear in the error message). Anything unmatched fails loudly.
//
// When a real fuzz-found bug is filed (its own `fuzz-found` issue, per #113),
// add a { invariant, messageIncludes, issue } entry here so the sweep stays
// green on the blocker while the fix is pending. Do NOT weaken invariants to go
// green: quarantine is explicit and auditable; weakening is silent. Quarantine
// is for triaged, filed bugs only: `rename-no-edit-lost` is NOT quarantined,
// because the sweep found a silent-loss path on main that still needs filing.

export interface KnownFailure {
  /** FuzzError.invariant this applies to (exact match). */
  invariant: string;
  /** Substring that must appear in FuzzError.details/message to match. */
  messageIncludes: string;
  /** Tracking issue for the quarantined bug (documentation only). */
  issue: string;
}

// Quarantine list: known, tracked product bugs that the fuzz suite reproduces
// while the fix is pending. Prior blockers (#117, #124, #127) are fixed and merged.
// The baseline leak was a harness bug (hubs not closed before clear), not a product divergence.
export const KNOWN_FAILURES: KnownFailure[] = [
  // Empty: #583 PR 2 fixed the rename-resurrected-name case (a renamed-away name
  // coming back): the oracle must now pass, so the entry was dropped.
];

/** Return the matching known-failure signature for a FuzzError, or null. */
export function matchKnownFailure(err: FuzzError): KnownFailure | null {
  for (const kf of KNOWN_FAILURES) {
    if (err.invariant === kf.invariant && err.message.includes(kf.messageIncludes)) {
      return kf;
    }
  }
  return null;
}

// ── Presets ──────────────────────────────────────────────────────────────
// Pre-defined fuzz configurations for common testing scenarios.

export interface FuzzPreset {
  name: string;
  runner: "sequence" | "concurrent" | "concurrent-binary" | "triple" | "rename";
  seeds: number;
  turns: number;
  opsPerTurn?: number;
  devices?: 2 | 3;
  /** Oracle 4 for the rename runner: needs #583 PR 2. */
  historyLinks?: boolean;
  chaos?: ChaosOpts;
}

export const PRESETS: Record<string, FuzzPreset> = {
  "daily-cycle": {
    name: "daily-cycle",
    runner: "sequence",
    seeds: 5,
    turns: 8,
    opsPerTurn: 3,
  },
  "large-vault": {
    name: "large-vault",
    runner: "sequence",
    seeds: 3,
    turns: 20,
    opsPerTurn: 10,
  },
  "offline-conflict": {
    name: "offline-conflict",
    runner: "concurrent",
    seeds: 5,
    turns: 6,
  },
  "restart-storm": {
    name: "restart-storm",
    runner: "sequence",
    seeds: 3,
    turns: 8,
    opsPerTurn: 4,
    chaos: { probability: 0.8, restart: true, reconnect: true },
  },
  "three-device-fanout": {
    name: "three-device-fanout",
    runner: "triple",
    seeds: 3,
    turns: 4,
  },
  "rename-storm": {
    name: "rename-storm",
    runner: "rename",
    seeds: 3,
    turns: 4,
  },
};

/**
 * Run a preset: loops over `preset.seeds` seeds starting at `startSeed`,
 * dispatching to the correct runner. Quarantined failures are logged and
 * skipped; unknown failures rethrow.
 */
export async function runPreset(preset: FuzzPreset, startSeed: number): Promise<void> {
  for (let i = 0; i < preset.seeds; i++) {
    const seed = startSeed + i;
    try {
      switch (preset.runner) {
        case "sequence":
          await runSequence({
            seed,
            turns: preset.turns,
            opsPerTurn: preset.opsPerTurn ?? 5,
            chaos: preset.chaos,
          });
          break;
        case "concurrent":
          await runConcurrentSequence({ seed, turns: preset.turns });
          break;
        case "concurrent-binary":
          await runConcurrentBinarySequence({ seed, turns: preset.turns });
          break;
        case "triple":
          await runTripleSequence({ seed, turns: preset.turns });
          break;
        case "rename":
          await runRenameSequence({
            seed,
            turns: preset.turns,
            devices: preset.devices,
            opsPerTurn: preset.opsPerTurn,
            historyLinks: preset.historyLinks,
          });
          break;
      }
    } catch (e) {
      if (e instanceof FuzzError && matchKnownFailure(e)) {
        console.log(
          `QUARANTINED [preset=${preset.name} seed=${seed}]: ${e.invariant} (${
            e.message.split("\n")[0]
          }) (issue: ${matchKnownFailure(e)!.issue})`,
        );
        continue;
      }
      throw e;
    }
  }
}

// ── M2b: Concurrent divergent-edit fuzzing ─────────────────────────────
//
// Both devices edit the SAME markdown file divergently before syncing,
// forcing the plugin's 3-way merge / conflict path. Checks a WEAKER
// invariant set (convergence + no-marker-leakage + seq-monotonic).
// Does NOT check oracle equality or forbid .conflict files.

/** Plain-ASCII word pool for mergeable content (no markers, no control chars). */
const MERGE_WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "mike",
  "november",
  "oscar",
  "papa",
  "quebec",
  "romeo",
  "sierra",
  "tango",
  "uniform",
  "victor",
  "whiskey",
  "xray",
  "yankee",
  "zulu",
  "apple",
  "banana",
  "cherry",
  "dragon",
  "eagle",
  "falcon",
  "grape",
  "horse",
  "island",
  "jungle",
  "kitten",
  "lemon",
  "mountain",
  "ninja",
  "ocean",
  "panda",
  "queen",
  "river",
  "sun",
  "tiger",
  "umbrella",
  "volcano",
  "water",
  "xenon",
  "yellow",
  "zebra",
  "anchor",
  "bridge",
  "castle",
  "dream",
  "forest",
  "garden",
  "harbor",
  "ivory",
  "jacket",
  "knight",
  "lagoon",
  "marble",
  "noble",
  "olive",
  "pearl",
  "quartz",
  "rabbit",
  "silver",
  "torch",
  "unicorn",
  "violet",
  "winter",
  "yacht",
  "zenith",
];

/** Generate plain-ASCII markdown content from base lines, with random edits. */
export function makeMergeableContent(rng: Rng, base: string[]): { text: string } {
  const lines = [...base];
  const numEdits = 1 + rng.int(3); // 1..3 edits

  for (let i = 0; i < numEdits; i++) {
    const action = rng.int(3);
    const idx = rng.int(Math.max(lines.length, 1));
    const word = MERGE_WORDS[rng.int(MERGE_WORDS.length)];
    const word2 = MERGE_WORDS[rng.int(MERGE_WORDS.length)];
    const lineContent = `${word}-${word2}-${rng.nextU32().toString(16)}`;

    if (action === 0) {
      // Edit an existing line
      if (lines.length > 0) {
        lines[idx % lines.length] = lineContent;
      } else {
        lines.push(lineContent);
      }
    } else if (action === 1) {
      // Insert at position
      lines.splice(Math.min(idx, lines.length), 0, lineContent);
    } else {
      // Append
      lines.push(lineContent);
    }
  }

  return { text: lines.join("\n") };
}

/**
 * Generate two divergent edits from the same base. Guarantees both differ
 * from base and from each other.
 */
/**
 * Generate two divergent edits from the same base, each tagged with a unique
 * greppable token on a DIFFERENT line index so a clean 3-way merge preserves
 * both. Tokens are plain ASCII (no conflict markers). Returns the two tokens
 * for the no-loss invariant.
 */
export function makeTaggedDivergentEdits(
  rng: Rng,
  base: string[],
  turn: number,
): { a: string; b: string; tokenA: string; tokenB: string } {
  const tokenA = `CTOKEN_A_${turn}`;
  const tokenB = `CTOKEN_B_${turn}`;

  const wordA = MERGE_WORDS[rng.int(MERGE_WORDS.length)];
  const wordB = MERGE_WORDS[rng.int(MERGE_WORDS.length)];
  const lineA = `edit-a-${turn}-${wordA} ${tokenA}`;
  const lineB = `edit-b-${turn}-${wordB} ${tokenB}`;

  // Pick two different line indices so edits are non-overlapping.
  const maxIdx = Math.max(base.length, 1);
  const idxA = rng.int(maxIdx);
  let idxB = rng.int(maxIdx);
  while (idxB === idxA && base.length > 1) {
    idxB = rng.int(maxIdx);
  }

  // Build A's version: replace (or append) at idxA with tagged line.
  const linesA = [...base];
  if (idxA < linesA.length) {
    linesA[idxA] = lineA;
  } else {
    linesA.push(lineA);
  }

  // Build B's version: replace (or append) at idxB with tagged line.
  const linesB = [...base];
  if (idxB < linesB.length) {
    linesB[idxB] = lineB;
  } else {
    linesB.push(lineB);
  }

  return { a: linesA.join("\n"), b: linesB.join("\n"), tokenA, tokenB };
}

/**
 * Weaker invariant set for concurrent mode.
 * - convergence: A and B must have identical files
 * - no-marker-leakage: no markdown file contains raw conflict markers
 * - seq-monotonic: server version seq is strictly increasing
 *
 * Does NOT check oracle equality. Does NOT forbid .conflict files.
 */
export function checkConcurrentInvariants(
  A: TestPlugin,
  B: TestPlugin,
  db: DbHandle,
  vaultId: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  // Conflict files sync like any file (#432): a device that surfaced a
  // conflict commits it, so its peer converges on the same set on disk.
  const conv = mapsEqual(A.fakeVault.files, B.fakeVault.files);
  if (!conv.equal) {
    throw new FuzzError(seed, "convergence", `A and B diverged: ${conv.diff}`, opTrace);
  }

  // Empty markerPaths: in concurrent mode we never intentionally write marker content,
  // so ANY marker on disk is a real merge leak.
  const markerA = checkMarkerLeakage(A.fakeVault.files, new Set());
  if (markerA) {
    throw new FuzzError(seed, "marker-leakage-A", markerA, opTrace);
  }
  const markerB = checkMarkerLeakage(B.fakeVault.files, new Set());
  if (markerB) {
    throw new FuzzError(seed, "marker-leakage-B", markerB, opTrace);
  }

  const seqErr = checkSeqMonotonic(db, vaultId);
  if (seqErr) {
    throw new FuzzError(seed, "seq-monotonic", seqErr, opTrace);
  }
}

export interface RunConcurrentSequenceOpts {
  seed: number;
  turns: number;
}

/** Concatenate every file's text on a device so a token can be found anywhere (incl. conflict files). */
function vaultText(files: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  let text = "";
  for (const data of files.values()) text += decoder.decode(data) + "\n";
  return text;
}

/**
 * No-loss invariant: after a concurrent turn, both sides' edits must be
 * present somewhere on disk: either merged into the main file or preserved
 * in a .conflict file. Silent loss (one edit dropped with no conflict) fails.
 */
export function checkNoLoss(
  device: TestPlugin,
  tokenA: string,
  tokenB: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  const allText = vaultText(device.fakeVault.files);

  if (!allText.includes(tokenA)) {
    throw new FuzzError(
      seed,
      "concurrent-loss",
      `lost A edit: ${tokenA} (no .conflict)`,
      opTrace,
    );
  }

  if (!allText.includes(tokenB)) {
    throw new FuzzError(
      seed,
      "concurrent-loss",
      `lost B edit: ${tokenB} (no .conflict)`,
      opTrace,
    );
  }
}

export async function runConcurrentSequence(opts: RunConcurrentSequenceOpts): Promise<void> {
  const rng = new Rng(opts.seed);
  const opTrace: TraceEntry[] = [];

  // --- Background-rejection trap ---
  let backgroundRejection: unknown = null;
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    if (backgroundRejection == null) backgroundRejection = e.reason;
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  const throwIfRejected = (trace: TraceEntry[]) => {
    if (backgroundRejection != null) {
      const msg = backgroundRejection instanceof Error
        ? (backgroundRejection.stack ?? backgroundRejection.message)
        : String(backgroundRejection);
      throw new FuzzError(opts.seed, "background-rejection", String(msg), trace);
    }
  };

  const paired = await pair();
  const { server, vaultId } = paired;
  const A = paired.A;
  const B = paired.B;

  try {
    // --- Warmup: create 3 shared markdown files on A, push, settle ---
    const sharedPaths: string[] = [];
    const baseLines = new Map<string, string[]>();
    const encoder = new TextEncoder();

    for (let i = 0; i < 3; i++) {
      const path = `shared-${i}.md`;
      const lines = Array.from(
        { length: 5 + rng.int(10) },
        () =>
          `${MERGE_WORDS[rng.int(MERGE_WORDS.length)]}-${MERGE_WORDS[rng.int(MERGE_WORDS.length)]}`,
      );
      const text = lines.join("\n");
      A.fakeVault.writeBinary(path, encoder.encode(text));
      sharedPaths.push(path);
      baseLines.set(path, lines);
    }

    await A.pushNow();
    await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);

    // --- Concurrent turns ---
    for (let turn = 0; turn < opts.turns; turn++) {
      const path = sharedPaths[rng.int(sharedPaths.length)];
      const currentBase = baseLines.get(path) ?? [];

      // Make two tagged divergent edits from the same base.
      // Each side gets a unique greppable token on a different line index
      // so a clean 3-way merge should keep BOTH tokens.
      const { a: bodyA, b: bodyB, tokenA, tokenB } = makeTaggedDivergentEdits(
        rng,
        currentBase,
        turn,
      );

      // Apply WITHOUT syncing between them
      A.fakeVault.writeBinary(path, encoder.encode(bodyA));
      B.fakeVault.writeBinary(path, encoder.encode(bodyB));

      // Push A first (commits + lands on server), then B (reconciles against
      // A's committed version and must 3-way-merge its local edit).
      await A.pushNow();
      await B.pushNow();

      // Settle to quiescence
      await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);

      // Extra reconcile for determinism: ensure B has fully processed any
      // deferred work before we check invariants.
      await B.reconcileNow();

      // Update base to what A now has on disk (the converged content)
      const convergedData = A.fakeVault.files.get(path);
      if (convergedData) {
        const convergedText = new TextDecoder().decode(convergedData);
        baseLines.set(path, convergedText.split("\n"));
      }

      opTrace.push({ kind: "concurrent", path, turn });

      // Check concurrent invariants
      checkConcurrentInvariants(A, B, server.db, vaultId, opts.seed, opTrace);

      // No-loss invariant: both sides' tokens must survive somewhere on disk
      // (merged into the main file or preserved in a .conflict file).
      checkNoLoss(A, tokenA, tokenB, opts.seed, opTrace);
    }

    // --- No-op resync check ---
    const preResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected(opTrace);

    const postResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    if (preResyncCount.n !== postResyncCount.n) {
      throw new FuzzError(
        opts.seed,
        "no-op-resync-version-count",
        `version count changed during no-op resync: ${preResyncCount.n} -> ${postResyncCount.n}`,
        opTrace,
      );
    }

    checkConcurrentInvariants(A, B, server.db, vaultId, opts.seed, opTrace);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    try {
      A.stop();
    } catch { /* already stopped */ }
    try {
      B.stop();
    } catch { /* already stopped */ }
    await server.stop();
  }
}

// ── M2b: Concurrent binary-conflict fuzzing ────────────────────────────
//
// Both devices edit the SAME binary file divergently before syncing.
// Binary files CANNOT 3-way merge, so the correct outcome is a .conflict
// file that preserves the losing side: never a silent overwrite, never
// a merge. Checks convergence + binary-no-loss + seq-monotonic.

/**
 * Generate pseudo-random binary content with an embedded, findable signature.
 * The signature is ASCII bytes of `BSIG_<side>_<turn>` placed at offset 16,
 * surrounded by 0x00 bytes to ensure the file is classified as binary.
 */
export function makeTaggedBinaryContent(
  rng: Rng,
  turn: number,
  side: "A" | "B",
): { bytes: Uint8Array; signature: Uint8Array; signatureStr: string } {
  const sigStr = `BSIG_${side}_${turn}`;
  const sigBytes = new TextEncoder().encode(sigStr);
  const size = 256 + rng.int(4096);
  const buf = new Uint8Array(size);

  // Fill with random bytes (include 0x00 to ensure binary classification)
  for (let i = 0; i < size; i++) {
    buf[i] = rng.nextU32() & 0xff;
  }

  // Embed signature at a known offset (16), padded with 0xFF on both sides
  const offset = 16;
  buf[offset - 1] = 0xff;
  for (let i = 0; i < sigBytes.length; i++) {
    buf[offset + i] = sigBytes[i];
  }
  buf[offset + sigBytes.length] = 0xff;

  // Ensure there's at least one 0x00 byte somewhere (binary classification)
  buf[0] = 0x00;
  buf[size - 1] = 0x00;

  return { bytes: buf, signature: sigBytes, signatureStr: sigStr };
}

/**
 * Binary no-loss invariant: after a concurrent binary turn, both sides'
 * signatures must be present somewhere on disk: one in the main file,
 * one in a .conflict file (or vice versa). Missing either → silent loss.
 */
export function checkBinaryNoLoss(
  device: TestPlugin,
  sigA: Uint8Array,
  sigB: Uint8Array,
  sigAStr: string,
  sigBStr: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  let foundA = false;
  let foundB = false;

  for (const [, data] of device.fakeVault.files) {
    if (!foundA) {
      foundA = includesBytes(data, sigA);
    }
    if (!foundB) {
      foundB = includesBytes(data, sigB);
    }
    if (foundA && foundB) break;
  }

  if (!foundA) {
    throw new FuzzError(
      seed,
      "concurrent-binary-loss",
      `lost A binary edit: ${sigAStr} (no .conflict)`,
      opTrace,
    );
  }

  if (!foundB) {
    throw new FuzzError(
      seed,
      "concurrent-binary-loss",
      `lost B binary edit: ${sigBStr} (no .conflict)`,
      opTrace,
    );
  }
}

/** Check if needle bytes appear anywhere in haystack. */
function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export interface RunConcurrentBinarySequenceOpts {
  seed: number;
  turns: number;
}

/**
 * Concurrent binary-conflict fuzzing: two devices edit the same binary file
 * divergently. Binary files can't 3-way merge, so a .conflict file must be
 * created preserving the losing side.
 */
export async function runConcurrentBinarySequence(
  opts: RunConcurrentBinarySequenceOpts,
): Promise<void> {
  const rng = new Rng(opts.seed);
  const opTrace: TraceEntry[] = [];

  // --- Background-rejection trap ---
  let backgroundRejection: unknown = null;
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    if (backgroundRejection == null) backgroundRejection = e.reason;
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  const throwIfRejected = (trace: TraceEntry[]) => {
    if (backgroundRejection != null) {
      const msg = backgroundRejection instanceof Error
        ? (backgroundRejection.stack ?? backgroundRejection.message)
        : String(backgroundRejection);
      throw new FuzzError(opts.seed, "background-rejection", String(msg), trace);
    }
  };

  const paired = await pair();
  const { server, vaultId } = paired;
  const A = paired.A;
  const B = paired.B;

  try {
    // --- Warmup: create 2 shared .bin files on A, push, settle ---
    const sharedPaths: string[] = [];

    for (let i = 0; i < 2; i++) {
      const path = `shared-${i}.bin`;
      const warmupContent = makeTaggedBinaryContent(rng, -1, "A");
      A.fakeVault.writeBinary(path, warmupContent.bytes);
      sharedPaths.push(path);
    }

    await A.pushNow();
    await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);

    // --- Concurrent binary turns ---
    for (let turn = 0; turn < opts.turns; turn++) {
      const path = sharedPaths[rng.int(sharedPaths.length)];

      // Make two DIFFERENT tagged binary blobs.
      const contentA = makeTaggedBinaryContent(rng, turn, "A");
      const contentB = makeTaggedBinaryContent(rng, turn, "B");

      // Write bodyA to A and bodyB to B with NO sync between.
      A.fakeVault.writeBinary(path, contentA.bytes);
      B.fakeVault.writeBinary(path, contentB.bytes);

      // Push A first (commits + lands on server), then B (reconciles against
      // A's committed version and must create a .conflict file).
      await A.pushNow();
      await B.pushNow();

      // Settle to quiescence
      await settle(server.db, vaultId, A, B, 12, opts.seed, opTrace, throwIfRejected);

      // Extra reconcile for determinism
      await B.reconcileNow();

      opTrace.push({ kind: "concurrent-binary", path, turn });

      // Check concurrent invariants (convergence + seq-monotonic;
      // marker leakage is irrelevant for binary but harmless)
      checkConcurrentInvariants(A, B, server.db, vaultId, opts.seed, opTrace);

      // Binary no-loss: both signatures must survive somewhere on disk
      // (one in main file, one in .conflict sibling synced to both).
      checkBinaryNoLoss(
        A,
        contentA.signature,
        contentB.signature,
        contentA.signatureStr,
        contentB.signatureStr,
        opts.seed,
        opTrace,
      );
    }

    // --- No-op resync check ---
    const preResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    await A.reconcileNow();
    await B.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected(opTrace);

    const postResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    if (preResyncCount.n !== postResyncCount.n) {
      throw new FuzzError(
        opts.seed,
        "no-op-resync-version-count",
        `version count changed during no-op resync: ${preResyncCount.n} -> ${postResyncCount.n}`,
        opTrace,
      );
    }

    checkConcurrentInvariants(A, B, server.db, vaultId, opts.seed, opTrace);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    try {
      A.stop();
    } catch { /* already stopped */ }
    try {
      B.stop();
    } catch { /* already stopped */ }
    await server.stop();
  }
}

// ── M2b: 3-device concurrent fuzzing ──────────────────────────────────
//
// Three synced devices. Two edit the same file concurrently; the THIRD
// must also converge to the same result with no lost edit.

/**
 * 3-device convergence invariant: all three devices must have identical
 * file maps, no marker leakage on any device, and seq monotonic.
 */
export function checkTripleConvergence(
  A: TestPlugin,
  B: TestPlugin,
  C: TestPlugin,
  db: DbHandle,
  vaultId: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  const convAB = mapsEqual(A.fakeVault.files, B.fakeVault.files);
  if (!convAB.equal) {
    throw new FuzzError(seed, "convergence", `A and B diverged: ${convAB.diff}`, opTrace);
  }

  const convBC = mapsEqual(B.fakeVault.files, C.fakeVault.files);
  if (!convBC.equal) {
    throw new FuzzError(seed, "convergence", `B and C diverged: ${convBC.diff}`, opTrace);
  }

  // Marker leakage on all three devices
  const markerA = checkMarkerLeakage(A.fakeVault.files, new Set());
  if (markerA) {
    throw new FuzzError(seed, "marker-leakage-A", markerA, opTrace);
  }
  const markerB = checkMarkerLeakage(B.fakeVault.files, new Set());
  if (markerB) {
    throw new FuzzError(seed, "marker-leakage-B", markerB, opTrace);
  }
  const markerC = checkMarkerLeakage(C.fakeVault.files, new Set());
  if (markerC) {
    throw new FuzzError(seed, "marker-leakage-C", markerC, opTrace);
  }

  const seqErr = checkSeqMonotonic(db, vaultId);
  if (seqErr) {
    throw new FuzzError(seed, "seq-monotonic", seqErr, opTrace);
  }
}

/**
 * 3-device no-loss invariant: both edit tokens must be present on EACH
 * of the three devices (search all files incl. .conflict).
 */
export function checkTripleNoLoss(
  A: TestPlugin,
  B: TestPlugin,
  C: TestPlugin,
  tokenA: string,
  tokenB: string,
  seed: number,
  opTrace: TraceEntry[],
): void {
  for (
    const [label, device] of [
      ["A", A],
      ["B", B],
      ["C", C],
    ] as [string, TestPlugin][]
  ) {
    const allText = vaultText(device.fakeVault.files);

    if (!allText.includes(tokenA)) {
      throw new FuzzError(
        seed,
        "triple-loss",
        `lost side-A edit on ${label}: ${tokenA}`,
        opTrace,
      );
    }

    if (!allText.includes(tokenB)) {
      throw new FuzzError(
        seed,
        "triple-loss",
        `lost side-B edit on ${label}: ${tokenB}`,
        opTrace,
      );
    }
  }
}

export interface RunTripleSequenceOpts {
  seed: number;
  turns: number;
}

/**
 * 3-device concurrent fuzzing: three synced devices, two edit the same
 * file concurrently each turn, the third must converge to the same result
 * with no lost edit.
 */
export async function runTripleSequence(opts: RunTripleSequenceOpts): Promise<void> {
  const rng = new Rng(opts.seed);
  const opTrace: TraceEntry[] = [];

  // --- Background-rejection trap ---
  let backgroundRejection: unknown = null;
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    if (backgroundRejection == null) backgroundRejection = e.reason;
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  const throwIfRejected = (trace: TraceEntry[]) => {
    if (backgroundRejection != null) {
      const msg = backgroundRejection instanceof Error
        ? (backgroundRejection.stack ?? backgroundRejection.message)
        : String(backgroundRejection);
      throw new FuzzError(opts.seed, "background-rejection", String(msg), trace);
    }
  };

  const tri = await triple();
  const { server, vaultId } = tri;
  const A = tri.A;
  const B = tri.B;
  const C = tri.C;

  try {
    // --- Warmup: create ~3 shared markdown files on A, push, settle all three ---
    const sharedPaths: string[] = [];
    const baseLines = new Map<string, string[]>();
    const encoder = new TextEncoder();

    for (let i = 0; i < 3; i++) {
      const path = `shared-${i}.md`;
      const lines = Array.from(
        { length: 5 + rng.int(10) },
        () =>
          `${MERGE_WORDS[rng.int(MERGE_WORDS.length)]}-${MERGE_WORDS[rng.int(MERGE_WORDS.length)]}`,
      );
      const text = lines.join("\n");
      A.fakeVault.writeBinary(path, encoder.encode(text));
      sharedPaths.push(path);
      baseLines.set(path, lines);
    }

    await A.pushNow();
    await settleDevices([A, B, C], 20, opts.seed, opTrace, throwIfRejected);

    // --- Concurrent turns ---
    const writerPairs: Array<[TestPlugin, TestPlugin, string]> = [
      [A, B, "AB"],
      [B, C, "BC"],
      [A, C, "AC"],
    ];

    for (let turn = 0; turn < opts.turns; turn++) {
      const path = sharedPaths[rng.int(sharedPaths.length)];
      const currentBase = baseLines.get(path) ?? [];

      // Pick two distinct writer devices (seeded rotation)
      const pair = writerPairs[rng.int(writerPairs.length)];
      const [writer1, writer2, pairLabel] = pair;

      // Make two tagged divergent edits from the same base.
      const { a: body1, b: body2, tokenA, tokenB } = makeTaggedDivergentEdits(
        rng,
        currentBase,
        turn,
      );

      // Apply WITHOUT syncing between them
      writer1.fakeVault.writeBinary(path, encoder.encode(body1));
      writer2.fakeVault.writeBinary(path, encoder.encode(body2));

      // Push writer1 first, then writer2
      await writer1.pushNow();
      await writer2.pushNow();

      // Settle all three to quiescence
      await settleDevices([A, B, C], 20, opts.seed, opTrace, throwIfRejected);

      // Extra reconcile for determinism
      await A.reconcileNow();
      await B.reconcileNow();
      await C.reconcileNow();

      // Update base to what A now has on disk (the converged content)
      const convergedData = A.fakeVault.files.get(path);
      if (convergedData) {
        const convergedText = new TextDecoder().decode(convergedData);
        baseLines.set(path, convergedText.split("\n"));
      }

      opTrace.push({ kind: "triple", path, turn, writers: pairLabel });

      // Check invariants
      checkTripleConvergence(A, B, C, server.db, vaultId, opts.seed, opTrace);
      checkTripleNoLoss(A, B, C, tokenA, tokenB, opts.seed, opTrace);
    }

    // --- No-op resync check ---
    const preResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    await A.reconcileNow();
    await B.reconcileNow();
    await C.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected(opTrace);

    const postResyncCount = server.db.prepare(
      "SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?",
    ).get(vaultId) as { n: number };

    if (preResyncCount.n !== postResyncCount.n) {
      throw new FuzzError(
        opts.seed,
        "no-op-resync-version-count",
        `version count changed during no-op resync: ${preResyncCount.n} -> ${postResyncCount.n}`,
        opTrace,
      );
    }

    checkTripleConvergence(A, B, C, server.db, vaultId, opts.seed, opTrace);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    try {
      A.stop();
    } catch { /* already stopped */ }
    try {
      B.stop();
    } catch { /* already stopped */ }
    try {
      C.stop();
    } catch { /* already stopped */ }
    await server.stop();
  }
}

/** Settle N devices to quiescence.
 *
 * Terminates when a full reconcile round produces NO change to ANY device
 * AND every device's file map is byte-identical. Uses `mapsEqual` (full byte
 * comparison): not a cheap hash, so there are no false-equal positives.
 */
async function settleDevices(
  devices: TestPlugin[],
  maxRounds: number,
  seed: number,
  opTrace: TraceEntry[],
  throwIfRejected: (opTrace: TraceEntry[]) => void,
): Promise<void> {
  let consecutiveStableEqual = 0;

  for (let round = 0; round < maxRounds; round++) {
    const snapshot = devices.map((d) => new Map(d.fakeVault.files));
    for (const d of devices) await d.reconcileNow();
    await new Promise((r) => setTimeout(r, 0));
    throwIfRejected([...opTrace]);

    const stable = devices.every((d, i) => mapsEqual(d.fakeVault.files, snapshot[i]).equal);
    const equal = devices.every((d) =>
      mapsEqual(devices[0].fakeVault.files, d.fakeVault.files).equal
    );

    if (stable && equal) {
      consecutiveStableEqual++;
      if (consecutiveStableEqual >= 2) return;
    } else {
      consecutiveStableEqual = 0;
    }
  }

  const diffs = DEVICE_LABELS.slice(1, devices.length).map((label, i) => {
    const other = devices[i + 1].fakeVault.files;
    const same = mapsEqual(devices[0].fakeVault.files, other).equal;
    return `${DEVICE_LABELS[0]}${label}=${same ? "==" : "!="} ${
      describeDiff(devices[0].fakeVault.files, other)
    }`;
  });

  throw new FuzzError(
    seed,
    "settle-non-termination",
    `did not settle after ${maxRounds} rounds (devices not converged) ${diffs.join(" ")}`,
    opTrace,
  );
}

// ── M2b: concurrent rename fuzz (#587) ─────────────────────────────────
//
// 2-3 devices rename, move folders, edit, delete and reuse the same names at
// the same time: one device paused, disconnected or restarted mid-flight so the
// ops genuinely race. Unlike the divergent-edit runners above, which assert on
// one file, this tracks *intent* (a book of edits, deletes and renames) and
// checks the vaults once they quiesce:
//
//  1 convergence          every device's vault is byte-identical (per turn)
//  2 no edit lost         every edit's token is still on every device
//  3 no resurrected name  a name renamed away is gone unless an op re-created it
//  4 history links        the server's marker + note for each rename (off by
//                         default: needs #583 PR 2)
//
// Oracle 2 rules, deliberately simple:
//  - every create/edit embeds a unique token (`RN<dev>-<order>`) in its content;
//  - it is judged where the loss would happen: right after that turn quiesces,
//    because a later turn may legitimately overwrite the same file;
//  - content may be gone only if something later replaced it: a delete hitting a
//    path it occupied, or another write by the SAME device to that path. A write
//    by another device in the same turn is a race and never exempts: silent
//    loss there is exactly the bug this hunts.

const DEVICE_LABELS = ["A", "B", "C"];
const RENAME_FOLDERS = ["dir-a", "dir-b"];
const RENAME_NAMES = ["n0.md", "n1.md", "n2.md", "n3.md", "n4.md"];
/** Per turn: chance one device goes offline for the turn / one device restarts after it. */
const RENAME_OFFLINE_PROB = 0.5;
const RENAME_RESTART_PROB = 0.25;
/** Per turn: chance one device renames a note with the app stopped (no event). */
const RENAME_STOPPED_PROB = 0.2;

export interface DeviceView {
  label: string;
  files: Map<string, Uint8Array>;
}

export interface RenameRecord {
  from: string;
  to: string;
  order: number;
  /** The device that made the rename (its op, not the vaults'). */
  dev: number;
  /** Turn the rename was generated in (op order is global, turn is the window). */
  turn: number;
  /** The source name still held a file when the op ran (a marker is expected). */
  sourceOpen?: boolean;
  /** The destination name was free when the op ran (a note is expected). */
  destinationFree?: boolean;
  /** #583 PR 3: the rename was made with the event never delivered, so only the
   * reconciler could pair it (a create is required for the marker). */
  silent?: boolean;
  /** #629: the soak's flush epoch the rename was generated in: the rename and a delete
   * of its destination share one only while neither has been pushed. */
  epoch?: number;
}

interface EditRecord {
  token: string;
  order: number;
  dev: number;
  paths: string[];
}

interface DeleteRecord {
  path: string;
  order: number;
}

type RenameOp =
  | { kind: "create"; dev: number; turn: number; order: number; path: string; token: string }
  | { kind: "edit"; dev: number; turn: number; order: number; path: string; token: string }
  | { kind: "delete"; dev: number; turn: number; order: number; path: string }
  | {
    kind: "rename";
    dev: number;
    turn: number;
    order: number;
    from: string;
    to: string;
    folder?: string;
  };

/**
 * Intent log for the rename oracles: what the users asked for, in the order the
 * ops were generated. The vaults are compared against this after quiescence.
 */
export class RenameBook {
  readonly edits: EditRecord[] = [];
  readonly deletes: DeleteRecord[] = [];
  /** Each name renamed away, with the op that closed it (the latest one wins). */
  readonly renamedAway = new Map<string, { order: number; dev: number; turn: number }>();
  /** Names the intent log says currently hold a file (create / rename-to). */
  readonly occupied = new Set<string>();

  /** A create or edit: its token must exist on every device afterwards. */
  addEdit(dev: number, token: string, order: number, path: string): void {
    this.edits.push({ token, order, dev, paths: [path] });
  }

  /** A fresh file at `path` owns the name: an earlier rename-away of it is history. */
  addCreate(path: string): void {
    this.renamedAway.delete(path);
    this.occupied.add(path);
  }

  addDelete(path: string, order: number): void {
    this.deletes.push({ path, order });
    this.occupied.delete(path);
  }

  /** #629: the destination of a rename was deleted before it ever opened: the client
   * writes one plain delete of the source, so the name is not "renamed away" (a delete
   * is undone by a peer's racing edit, the way any deleted file is) and no name was
   * opened at the destination. The rename record stays for the history-link oracle. */
  cancelRename(from: string, to: string): void {
    this.renamedAway.delete(from);
    this.occupied.delete(to);
  }

  addRename(from: string, to: string, order: number, dev: number, turn: number): void {
    for (const edit of this.edits) if (edit.paths.includes(from)) edit.paths.push(to);
    this.renamedAway.set(from, { order, dev, turn });
    this.occupied.delete(from);
    this.occupied.add(to);
  }

  /**
   * Content may be gone only when something LATER legitimately replaced it:
   * - a delete hitting a path that content occupied, or
   * - a later write by the SAME device to a path it occupied (the user
   *   overwrote their own file).
   * A later write by ANOTHER device is a race and never exempts.
   */
  isExempt(edit: EditRecord): boolean {
    return this.deletes.some((d) => d.order > edit.order && edit.paths.includes(d.path)) ||
      this.edits.some((e) =>
        e.dev === edit.dev && e.order > edit.order && edit.paths.includes(e.paths[0])
      );
  }
}

export function checkRenameConvergence(
  views: DeviceView[],
  seed: number,
  opTrace: TraceEntry[],
): void {
  for (let i = 1; i < views.length; i++) {
    const cmp = mapsEqual(views[0].files, views[i].files);
    if (!cmp.equal) {
      throw new FuzzError(
        seed,
        "rename-convergence",
        `${views[0].label} and ${views[i].label} diverged: ${cmp.diff}: ${
          describeDiff(views[0].files, views[i].files)
        }`,
        opTrace,
      );
    }
  }
}

export function checkRenameNoEditLost(
  views: DeviceView[],
  book: RenameBook,
  seed: number,
  opTrace: TraceEntry[],
  edits: EditRecord[] = book.edits,
): void {
  const texts = views.map((v) => ({ label: v.label, text: vaultText(v.files) }));
  const lost: string[] = [];
  for (const edit of edits) {
    if (book.isExempt(edit)) continue;
    const missing = texts.filter((t) => !t.text.includes(edit.token)).map((t) => t.label);
    if (missing.length > 0) {
      lost.push(
        `${edit.token} (op ${edit.order}, known at ${edit.paths.join(" | ")}) missing on ${
          missing.join(",")
        }`,
      );
    }
  }
  if (lost.length > 0) {
    throw new FuzzError(
      seed,
      "rename-no-edit-lost",
      `lost ${lost.length} of ${edits.length} edits:\n${lost.slice(0, 10).join("\n")}`,
      opTrace,
    );
  }
}

export function checkRenameNoResurrected(
  views: DeviceView[],
  book: RenameBook,
  renames: readonly RenameRecord[],
  seed: number,
  opTrace: TraceEntry[],
): void {
  const back: string[] = [];
  for (const [path, away] of book.renamedAway) {
    // A rename-into of the path: concurrent with the rename-away (same turn, any
    // device) or after it: re-creates the name, exactly like a create does (#587).
    const recreated = renames.some((r) =>
      r.to === path && (r.turn > away.turn ||
        (r.turn === away.turn && (r.dev !== away.dev || r.order > away.order)))
    );
    if (recreated) continue;
    const present = views.filter((v) => v.files.has(path)).map((v) => v.label);
    if (present.length > 0) {
      back.push(`${path} (renamed away at op ${away.order}) is back on ${present.join(",")}`);
    }
  }
  if (back.length > 0) {
    throw new FuzzError(
      seed,
      "rename-resurrected-name",
      `a name renamed away came back:\n${back.slice(0, 10).join("\n")}`,
      opTrace,
    );
  }
}

/**
 * Oracle 4 (#583): a rename is a marker on the old name's closing version
 * (`rename_mark` 1) plus a note on the new name's first version (`rename_mark`
 * 2). Off by default: it can only pass once #583 PR 2 writes the links.
 *
 * Matched by the *encrypted link the rename wrote* (`renamed_to` / `renamed_from`),
 * not by "the newest row of the path": pooled names are legitimately reused, so a
 * later generation's first/last version is not this rename's marker or note.
 */
export async function checkRenameHistoryLinks(
  db: DbHandle,
  vaultId: string,
  keys: VaultKeys,
  rawRenames: RenameRecord[],
  seed: number,
  opTrace: TraceEntry[],
): Promise<void> {
  const broken: string[] = [];
  const rowsOf = db.prepare(
    "SELECT version, deleted, rename_mark, enc_metadata FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
  );

  /** The version of the row carrying this rename's link (null when none). */
  const linkedVersion = async (
    path: string,
    mark: number,
    field: "renamed_to" | "renamed_from",
    want: string,
    fromVersion?: number,
  ): Promise<number | null> => {
    const pathHash = hashPathHex(keys.mac_key, path);
    const rows = rowsOf.all(vaultId, pathHash) as Array<{
      version: number;
      deleted: number;
      rename_mark: number;
      enc_metadata: Uint8Array;
    }>;
    for (const row of rows) {
      if (row.rename_mark !== mark) continue;
      const meta = await decryptMetadata(row.enc_metadata, keys, pathHash).catch(() => null);
      if (meta?.[field] !== want) continue;
      // The note must cap inside *this* rename's generation (0 = "unknown, use the
      // newest marker"), so an earlier generation's link cannot stand in for this one.
      if (fromVersion !== undefined) {
        const capped = meta.renamed_from_version ?? 0;
        if (capped !== 0 && capped < fromVersion) continue;
      }
      return row.version;
    }
    return null;
  };

  /** #629: the cancelled rename closes the source with a plain tombstone (a marker there
   * is still a link, and the deleted head's trash entry holds the history). A close the
   * source's own edit on another device won over leaves the file standing (#361), so no
   * tombstone is owed then: only a peer's write explains a live head. */
  const closedWithTombstone = (path: string, dev: number, deleteOrder: number): boolean => {
    const rows = rowsOf.all(vaultId, hashPathHex(keys.mac_key, path)) as Array<{
      deleted: number;
      rename_mark: number;
    }>;
    const head = rows.at(-1);
    if (head?.deleted === 1) return head.rename_mark === 0;
    return opTrace.some((o) =>
      (o.kind === "rn-edit" || o.kind === "rn-create") && o.path === path && o.dev !== dev &&
      o.order < deleteOrder
    );
  };

  // #615: a rename chain of one device (X → Y → Z): the file is renamed again before Y's
  // note can land, so nothing is written there and the chain's single link names X → Z.
  // A hop that did write its own link keeps the per-hop contract; the rest fold into one
  // virtual rename whose marker names the chain's end and whose note links to its start.
  // No turn term: the device's queue, not the harness's turn, decides what is one chain.
  const folded: RenameRecord[] = [];
  for (const r of rawRenames) {
    const prev = folded.findLast((f) =>
      f.dev === r.dev && f.to === r.from && f.order < r.order && !f.silent
    );
    if (!prev) {
      folded.push(r);
      continue;
    }
    const hopLinked = await linkedVersion(r.from, RENAME_MARKER, "renamed_to", r.to) !== null ||
      await linkedVersion(r.from, RENAME_NOTE, "renamed_from", prev.from) !== null;
    if (hopLinked) {
      folded.push(r);
      continue;
    }
    folded[folded.indexOf(prev)] = { ...prev, to: r.to, destinationFree: r.destinationFree };
  }
  const renames = folded;

  // One requirement per (source, destination) pair: two devices doing the same
  // rename write one marker/note between them, and a name that was already taken
  // (or already closed) legitimately carries neither.
  const pairs = new Map<
    string,
    {
      from: string;
      to: string;
      order: number;
      turn: number;
      dev: number;
      sourceOpen: boolean;
      destinationFree: boolean;
      silent: boolean;
    }
  >();
  for (const r of renames) {
    const key = `${r.from}\u0000${r.to}`;
    const prev = pairs.get(key);
    const order = Math.min(prev?.order ?? Infinity, r.order);
    pairs.set(key, {
      from: r.from,
      to: r.to,
      order,
      turn: order === r.order ? (r.turn ?? 0) : (prev?.turn ?? 0),
      dev: order === r.order ? r.dev : (prev?.dev ?? r.dev),
      sourceOpen: (prev?.sourceOpen ?? false) || (r.sourceOpen ?? true),
      destinationFree: (prev?.destinationFree ?? false) || (r.destinationFree ?? true),
      silent: (prev?.silent ?? false) || (r.silent ?? false),
    });
  }

  for (const p of pairs.values()) {
    // #583 decision 9: racing renames of one source keep one history: only one of
    // them can own the marker, and only the winning destination carries a note.
    const sourceRaced = renames.some((o) => o.from === p.from && o.to !== p.to);
    // A rename whose event was never delivered (#583 PR 3) is paired on a *create*. When
    // something other than this rename itself wrote the destination's name at or before
    // that turn, the reconcile sees a modify there instead, so no marker can be written.
    // The content still converges and both edits survive (decisions 5 + 9); only the
    // link is out of reach. The rename's own record must not excuse it.
    const destinationTouched = opTrace.some((o) =>
      "turn" in o && o.turn >= 0 && o.turn <= p.turn &&
      (o.kind === "rn-create" || o.kind === "rn-edit"
        ? o.path === p.to
        : o.kind === "rn-rename"
        ? o.to === p.to && o.order < p.order
        : false)
    );
    const markerRequired = p.sourceOpen && !sourceRaced && !(p.silent && destinationTouched);
    const markerVersion = markerRequired
      ? await linkedVersion(p.from, RENAME_MARKER, "renamed_to", p.to)
      : null;
    // A destination another rename opens (or one a create took inside this rename's own
    // window: its turn or earlier, never the harness's turn -1 seeding) keeps one link:
    // the later opener writes over an already-opened name.
    const destinationRaced = renames.some((o) => o.to === p.to && o.from !== p.from) ||
      opTrace.some((o) =>
        o.kind === "rn-create" && o.path === p.to && o.turn >= 0 && o.turn <= p.turn
      );
    // Only a rename that wrote a marker can demand the note cap at it: a source that was
    // already closed (decision 9) has no marker of its own to point at.
    const noteRequired = p.destinationFree && !sourceRaced && !destinationRaced &&
      !(p.silent && destinationTouched);
    const noteVersion = noteRequired
      ? await linkedVersion(p.to, RENAME_NOTE, "renamed_from", p.from, markerVersion ?? undefined)
      : null;
    // #629: the rename's own device deleted the name it opened before the note could
    // land (X → Y, then delete Y inside one window): the client cancels the rename, so
    // neither link may exist and the source ends in a plain tombstone carrying the
    // history, instead of a marker pointing at a name that never opens. A source that was
    // already closed writes nothing (decision 9), so it has no tombstone to show.
    const closeOp = p.sourceOpen && noteRequired && noteVersion === null
      ? opTrace.findLast((o) =>
        o.kind === "rn-delete" && o.dev === p.dev && o.turn === p.turn && o.path === p.to &&
        o.order > p.order
      )
      : undefined;
    if (closeOp !== undefined) {
      if (markerVersion !== null) {
        broken.push(`${p.from} -> ${p.to}: a cancelled rename left a marker on ${p.from}`);
      }
      if (!closedWithTombstone(p.from, p.dev, closeOp.order)) {
        broken.push(`${p.from}: deleted without a plain tombstone, its history has no trash entry`);
      }
      continue;
    }
    if (markerRequired && markerVersion === null) {
      broken.push(`${p.from} -> ${p.to}: no marker for this rename on ${p.from}`);
    }
    if (noteRequired && noteVersion === null) {
      broken.push(`${p.from} -> ${p.to}: no note for this rename on ${p.to}`);
    }
  }

  if (broken.length > 0) {
    throw new FuzzError(
      seed,
      "rename-history-links",
      `missing rename links:\n${broken.slice(0, 10).join("\n")}`,
      opTrace,
    );
  }
}

function tokenFor(dev: number, order: number): string {
  return `RN${dev}-${order}`;
}

function renameContent(token: string): Uint8Array {
  return new TextEncoder().encode(`head\n${token}\nbody\nfooter\n`);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Per-device state for one turn's op generation. */
interface DeviceTurn {
  dev: number;
  turn: number;
  /** Paths on the device now, updated as this turn's ops are generated. */
  live: Set<string>;
  /** Created or renamed-to this turn: never a delete/rename source. */
  fresh: Set<string>;
}

/** Op targets on the device: user notes only: conflict artifacts never carry rename links (#583 case 15). */
function renameSources(ctx: DeviceTurn): string[] {
  return [...ctx.live].filter((p) => p.endsWith(".md") && !ctx.fresh.has(p) && !isConflictPath(p));
}

/** A path nothing holds; `dev`+`order` is globally unique so the fallback never collides. */
function freshPath(rng: Rng, dev: number, order: number, live: Set<string>): string {
  const folder = rng.int(3) === 0 ? `${rng.pick(RENAME_FOLDERS)}/` : "";
  const pooled = `${folder}${rng.pick(RENAME_NAMES)}`;
  return live.has(pooled) ? `${folder}new-${dev}-${order}.md` : pooled;
}

/** A rename target: 40% a move into another folder (same name), else a fresh path. */
function renameTarget(
  rng: Rng,
  dev: number,
  order: number,
  live: Set<string>,
  from: string,
): string {
  if (rng.bool(0.4)) {
    const src = folderOf(from);
    const dst = src === "dir-a/"
      ? "dir-b/"
      : src === "dir-b/"
      ? "dir-a/"
      : `${rng.pick(RENAME_FOLDERS)}/`;
    const moved = `${dst}${basenameOf(from)}`;
    if (!live.has(moved)) return moved;
  }
  return freshPath(rng, dev, order, live);
}

/** `n0.md` -> `N0.md`; null when the stem has no letters to flip. */
function caseToggled(path: string): string | null {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const toggled = /[a-z]/.test(stem) ? stem.toUpperCase() : stem.toLowerCase();
  return toggled === stem ? null : `${folderOf(path)}${toggled}${dot > 0 ? name.slice(dot) : ""}`;
}

function createOp(rng: Rng, ctx: DeviceTurn, nextOrder: () => number): RenameOp {
  const order = nextOrder();
  const path = freshPath(rng, ctx.dev, order, ctx.live);
  ctx.live.add(path);
  ctx.fresh.add(path);
  return {
    kind: "create",
    dev: ctx.dev,
    turn: ctx.turn,
    order,
    path,
    token: tokenFor(ctx.dev, order),
  };
}

function plainRename(rng: Rng, ctx: DeviceTurn, nextOrder: () => number): RenameOp {
  const from = rng.pick(renameSources(ctx));
  const order = nextOrder();
  const to = renameTarget(rng, ctx.dev, order, ctx.live, from);
  ctx.live.delete(from);
  ctx.live.add(to);
  ctx.fresh.add(to);
  return { kind: "rename", dev: ctx.dev, turn: ctx.turn, order, from, to };
}

function caseRename(rng: Rng, ctx: DeviceTurn, nextOrder: () => number): RenameOp {
  const pairs = renameSources(ctx).flatMap((from) => {
    const to = caseToggled(from);
    return to !== null && !ctx.live.has(to) ? [{ from, to }] : [];
  });
  if (pairs.length === 0) return plainRename(rng, ctx, nextOrder);
  const { from, to } = rng.pick(pairs);
  const order = nextOrder();
  ctx.live.delete(from);
  ctx.live.add(to);
  ctx.fresh.add(to);
  return { kind: "rename", dev: ctx.dev, turn: ctx.turn, order, from, to };
}

/** Move a folder (each file inside) into the other folder: one op per file. */
function folderMove(rng: Rng, ctx: DeviceTurn, nextOrder: () => number): RenameOp[] {
  const src = rng.pick(RENAME_FOLDERS);
  const dst = src === "dir-a" ? "dir-b" : "dir-a";
  const ops: RenameOp[] = [];
  for (const from of renameSources(ctx)) {
    if (!from.startsWith(`${src}/`)) continue;
    const to = `${dst}/${from.slice(src.length + 1)}`;
    if (ctx.live.has(to)) continue;
    const order = nextOrder();
    ctx.live.delete(from);
    ctx.live.add(to);
    ctx.fresh.add(to);
    ops.push({ kind: "rename", dev: ctx.dev, turn: ctx.turn, order, from, to, folder: src });
  }
  return ops;
}

/** One device's next op(s); folder moves expand to one rename per file inside. */
function makeRenameOps(rng: Rng, ctx: DeviceTurn, nextOrder: () => number): RenameOp[] {
  const sources = renameSources(ctx);
  if (sources.length === 0) return [createOp(rng, ctx, nextOrder)];
  const weight = rng.int(100);
  if (weight < 22) return [createOp(rng, ctx, nextOrder)];
  if (weight < 55) {
    const order = nextOrder();
    const path = rng.pick(sources);
    return [{
      kind: "edit",
      dev: ctx.dev,
      turn: ctx.turn,
      order,
      path,
      token: tokenFor(ctx.dev, order),
    }];
  }
  if (weight < 68) {
    const order = nextOrder();
    return [{ kind: "delete", dev: ctx.dev, turn: ctx.turn, order, path: rng.pick(sources) }];
  }
  if (weight < 85) return [plainRename(rng, ctx, nextOrder)];
  if (weight < 92) return [caseRename(rng, ctx, nextOrder)];
  const moved = folderMove(rng, ctx, nextOrder);
  return moved.length > 0 ? moved : [plainRename(rng, ctx, nextOrder)];
}

/** Whether the op can be applied to this device's vault as generated. */
function opApplies(plugin: TestPlugin, op: RenameOp): boolean {
  if (op.kind === "rename") return plugin.fakeVault.files.has(op.from);
  if (op.kind === "delete") return plugin.fakeVault.files.has(op.path);
  return true;
}

function applyRenameOp(
  plugin: TestPlugin,
  book: RenameBook,
  op: RenameOp,
  renames: RenameRecord[],
): void {
  if (op.kind === "create" || op.kind === "edit") {
    plugin.fakeVault.writeBinary(op.path, renameContent(op.token));
    if (op.kind === "create") book.addCreate(op.path);
    book.addEdit(op.dev, op.token, op.order, op.path);
    return;
  }
  if (op.kind === "delete") {
    plugin.fakeVault.delete(op.path);
    book.addDelete(op.path, op.order);
    return;
  }
  const sourceOpen = book.occupied.has(op.from);
  const destinationFree = !book.occupied.has(op.to);
  plugin.fakeVault.rename(op.from, op.to);
  book.addRename(op.from, op.to, op.order, op.dev, op.turn);
  renames.push({
    from: op.from,
    to: op.to,
    order: op.order,
    dev: op.dev,
    turn: op.turn,
    sourceOpen,
    destinationFree,
  });
}

function renameTraceEntry(op: RenameOp): TraceEntry {
  if (op.kind === "rename") {
    return {
      kind: "rn-rename",
      dev: op.dev,
      turn: op.turn,
      order: op.order,
      from: op.from,
      to: op.to,
      folder: op.folder,
    };
  }
  if (op.kind === "delete") {
    return { kind: "rn-delete", dev: op.dev, turn: op.turn, order: op.order, path: op.path };
  }
  return {
    kind: op.kind === "create" ? "rn-create" : "rn-edit",
    dev: op.dev,
    turn: op.turn,
    order: op.order,
    path: op.path,
    token: op.token,
  };
}

export interface RunRenameSequenceOpts {
  seed: number;
  turns: number;
  devices?: 2 | 3;
  opsPerTurn?: number;
  /** Pause/disconnect one device per turn and restart one afterwards. Default on. */
  chaos?: boolean;
  /** Oracle 4: needs #583 PR 2 (main writes no markers yet). */
  historyLinks?: boolean;
}

interface RenameRun {
  seed: number;
  rng: Rng;
  devices: TestPlugin[];
  book: RenameBook;
  trace: TraceEntry[];
  renames: RenameRecord[];
  /** Global op counter: makes every token and generated path unique. */
  order: number;
  /**
   * Per-device model of the paths that device holds. Refreshed from the settled
   * vaults at the start of each turn and mutated by the ops this turn generates,
   * never read from a vault mid-turn, so a seed's op trace does not depend on
   * async timing.
   */
  model: Set<string>[];
  turn: number;
  opsPerTurn: number;
  chaos: boolean;
  throwIfRejected: (opTrace: TraceEntry[]) => void;
}

function deviceViews(devices: TestPlugin[]): DeviceView[] {
  return devices.map((d, i) => ({ label: DEVICE_LABELS[i], files: d.fakeVault.files }));
}

async function checkRenameOracles(
  run: RenameRun,
  db: DbHandle,
  vaultId: string,
  historyLinks: boolean,
): Promise<void> {
  const views = deviceViews(run.devices);
  checkRenameConvergence(views, run.seed, run.trace);
  checkRenameNoResurrected(views, run.book, run.renames, run.seed, run.trace);

  for (const v of views) {
    const leaked = checkMarkerLeakage(v.files, new Set());
    if (leaked) {
      throw new FuzzError(run.seed, "rename-marker-leakage", `${v.label}: ${leaked}`, run.trace);
    }
  }

  const seqErr = checkSeqMonotonic(db, vaultId);
  if (seqErr) throw new FuzzError(run.seed, "rename-seq-monotonic", seqErr, run.trace);

  if (historyLinks) {
    const keys = run.devices[0].keys;
    if (!keys) throw new Error("rename fuzz: device 0 has no keys");
    await checkRenameHistoryLinks(db, vaultId, keys, run.renames, run.seed, run.trace);
  }
}

async function warmupRename(run: RenameRun, _db: DbHandle, _vaultId: string): Promise<void> {
  for (const path of ["n0.md", "dir-a/n1.md", "dir-b/n2.md"]) {
    run.order++;
    const token = tokenFor(0, run.order);
    run.devices[0].fakeVault.writeBinary(path, renameContent(token));
    run.book.addCreate(path);
    run.book.addEdit(0, token, run.order, path);
    run.trace.push({ kind: "rn-create", dev: 0, turn: -1, order: run.order, path, token });
  }
  await run.devices[0].pushNow();
  await settleDevices(run.devices, 20, run.seed, run.trace, run.throwIfRejected);
  refreshModels(run);
}

/** The settled vaults are the next turn's starting model. */
function refreshModels(run: RenameRun): void {
  run.model = run.devices.map((d) => new Set(d.fakeVault.files.keys()));
}

/** One turn: op generation, racing pushes, optional offline window, restart chaos. */
async function renameTurn(run: RenameRun, server: TestServer, _vaultId: string): Promise<void> {
  const { rng, devices } = run;
  const order = shuffle(rng, devices.map((_, i) => i));
  const offline = run.chaos && rng.bool(RENAME_OFFLINE_PROB) ? rng.int(devices.length) : -1;
  const editStart = run.book.edits.length;
  if (offline >= 0) {
    const mode = rng.bool(0.5) ? "pause" : "disconnect";
    if (mode === "pause") devices[offline].pause();
    else devices[offline].disconnect();
    run.trace.push({ kind: "rn-offline", dev: offline, turn: run.turn, mode });
  }

  for (const dev of order) {
    const ctx: DeviceTurn = {
      dev,
      turn: run.turn,
      live: new Set(run.model[dev]),
      fresh: new Set(),
    };
    for (let k = 0; k < run.opsPerTurn; k++) {
      for (const op of makeRenameOps(rng, ctx, () => ++run.order)) {
        if (!opApplies(devices[dev], op)) continue; // model drifted (settle said otherwise): skip
        applyRenameOp(devices[dev], run.book, op, run.renames);
        run.trace.push(renameTraceEntry(op));
      }
    }
  }

  // Only the devices that can still talk push and settle; the offline one is
  // gated (pause) or transport-less (disconnect) and would only time out.
  const online = order.filter((dev) => dev !== offline);
  for (const dev of online) await devices[dev].pushNow();
  run.throwIfRejected(run.trace);
  await settleDevices(
    online.map((dev) => devices[dev]),
    20,
    run.seed,
    run.trace,
    run.throwIfRejected,
  );

  await bringOnline(run, offline);

  if (run.chaos && rng.bool(RENAME_RESTART_PROB)) {
    const dev = rng.int(devices.length);
    devices[dev] = await restartPlugin(devices[dev], server);
    run.trace.push({ kind: "rn-restart", dev, turn: run.turn });
    await settleDevices(devices, 20, run.seed, run.trace, run.throwIfRejected);
  }

  if (run.chaos && rng.bool(RENAME_STOPPED_PROB)) {
    const dev = rng.int(devices.length);
    await silentRenameWhileStopped(run, dev);
    await settleDevices(devices, 20, run.seed, run.trace, run.throwIfRejected);
  }

  // Per-turn window: a later turn's edit may legitimately overwrite this content,
  // so "no edit lost" is judged as soon as the turn's dust settles.
  const views = deviceViews(devices);
  checkRenameConvergence(views, run.seed, run.trace);
  checkRenameNoEditLost(views, run.book, run.seed, run.trace, run.book.edits.slice(editStart));
  refreshModels(run);
}

/** Return the device taken offline for this turn; its ops land in a world that moved. */
async function bringOnline(run: RenameRun, offline: number): Promise<void> {
  if (offline < 0) return;
  await run.devices[offline].resume();
  run.trace.push({ kind: "rn-online", dev: offline, turn: run.turn });
  await run.devices[offline].pushNow();
  await settleDevices(run.devices, 20, run.seed, run.trace, run.throwIfRejected);
}

/**
 * A rename the event stream never sees (#583 PR 3): the app is stopped, the bytes move
 * on disk, and nothing fires. On the way back up only the reconciler can tell it was a
 * rename: it must pair the create with the delete (marker + note), never duplicate the
 * file and never resurrect the old name.
 */
async function silentRenameWhileStopped(run: RenameRun, dev: number): Promise<void> {
  const plugin = run.devices[dev];
  const ctx: DeviceTurn = {
    dev,
    turn: run.turn,
    live: new Set(run.model[dev]),
    fresh: new Set(),
  };
  const sources = renameSources(ctx);
  if (sources.length === 0) return;
  const from = run.rng.pick(sources);
  const order = ++run.order;
  const to = renameTarget(run.rng, dev, order, ctx.live, from);
  const bytes = plugin.fakeVault.files.get(from);
  const target = plugin.state?.getLocalFile(to);
  // Obsidian refuses a rename onto a path that already exists, and so does this op: an
  // overwrite would be a harness-made data loss, and a destination this device or another
  // one still holds open is decision 9's race, not a missed rename (a rename onto an
  // open name cannot pair: the name is a modify, not a create).
  if (
    !bytes || plugin.fakeVault.files.has(to) || run.book.occupied.has(to) ||
    (target !== null && target !== undefined && !target.deleted)
  ) return;
  const mtime = plugin.fakeVault.mtimes.get(from) ?? Date.now();

  // The event is simply never delivered (a lost event, a mobile client that reports a
  // move as delete+create, an OS-level move while the app was stopped): only the
  // reconciler can tell this was a rename.
  plugin.fakeVault.files.delete(from);
  plugin.fakeVault.mtimes.delete(from);
  plugin.fakeVault.files.set(to, new Uint8Array(bytes));
  plugin.fakeVault.mtimes.set(to, mtime);

  const sourceOpen = run.book.occupied.has(from);
  const destinationFree = !run.book.occupied.has(to);
  run.book.addRename(from, to, order, dev, run.turn);
  run.renames.push({
    from,
    to,
    order,
    dev,
    turn: run.turn,
    sourceOpen,
    destinationFree,
    silent: true,
  });
  run.trace.push({
    kind: "rn-rename",
    dev,
    turn: run.turn,
    order,
    from,
    to,
    silent: true,
  });

  await plugin.pushNow();
}

export async function runRenameSequence(opts: RunRenameSequenceOpts): Promise<void> {
  let backgroundRejection: unknown = null;
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    if (backgroundRejection == null) backgroundRejection = e.reason;
  };
  globalThis.addEventListener("unhandledrejection", onRejection);

  const tri = opts.devices === 3 ? await triple() : null;
  const setup = tri ?? (await pair());
  const { server, vaultId } = setup;
  const devices = tri ? [tri.A, tri.B, tri.C] : [setup.A, setup.B];
  const run: RenameRun = {
    seed: opts.seed,
    rng: new Rng(opts.seed),
    devices,
    book: new RenameBook(),
    trace: [],
    renames: [],
    order: 0,
    model: [],
    turn: 0,
    opsPerTurn: opts.opsPerTurn ?? 2,
    chaos: opts.chaos ?? true,
    throwIfRejected: (trace: TraceEntry[]) => {
      if (backgroundRejection == null) return;
      const reason = backgroundRejection instanceof Error
        ? (backgroundRejection.stack ?? backgroundRejection.message)
        : String(backgroundRejection);
      throw new FuzzError(opts.seed, "background-rejection", String(reason), trace);
    },
  };

  try {
    await warmupRename(run, server.db, vaultId);
    for (run.turn = 0; run.turn < opts.turns; run.turn++) {
      await renameTurn(run, server, vaultId);
    }
    await checkRenameOracles(run, server.db, vaultId, opts.historyLinks ?? false);
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
    // Stop the CURRENT devices: restart chaos may have replaced instances.
    for (const device of run.devices) {
      try {
        device.stop();
      } catch { /* already stopped */ }
    }
    await server.stop();
  }
}
