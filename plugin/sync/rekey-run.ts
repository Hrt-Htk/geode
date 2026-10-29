// #557: re-key worker: re-encrypts every blob, version row and trash head
// from oldKeys to newKeys, then switches the vault. Obsidian-free: all I/O
// goes through RekeyClient, the resume cursor through an injected store.
// Chunking and nonce derivation are untouched (Rules 1 and 2): only the
// keys change, so every re-encrypted blob keeps its plaintext-hash ID.
import {
  authHashHex,
  decryptChunk,
  decryptMetadata,
  decryptPath,
  deriveAuthKey,
  encryptChunk,
  encryptMetadata,
  encryptPath,
  makeVerifier,
  type VaultKeys,
} from "../../core/crypto.ts";
import { hashPathHex } from "../../core/hash.ts";
import { b64decode, b64encode, type HeadRecord, type VersionRecord } from "../../core/protocol.ts";
import { log } from "../plumbing/log.ts";
import { HttpStatusError } from "../plumbing/provisioning-client.ts";

export type RekeyMode = "copy" | "replace";

// #675: the server only accepts a vault's first auth_hash from a caller holding
// the admin token, and the plugin keeps none: a vault that only ever auto-unlocked
// cannot rekey until it is registered once.
const AUTH_NOT_REGISTERED =
  "This vault is not set up for rekey yet. Open Settings, run the setup wizard, join this vault again with the admin token, then retry.";

// Wire shape of a re-key version row (server/rekey-routes.ts): enc_metadata /
// path_ciphertext travel base64, chunk_hashes is a JSON array string.
export interface RekeyVersionRow {
  version: number;
  parent: number | null;
  seq: number;
  path_hash: string;
  enc_metadata: string;
  chunk_hashes: string;
  deleted: number;
  device_id: string;
  created_at: number;
  compacted_range: string | null;
  path_ciphertext: string | null;
  /** #583: 0 = ordinary version, RENAME_MARKER | RENAME_NOTE; a re-key that
   * drops it erases every rename link (and #582 would erase renamed histories). */
  rename_mark?: number;
  /** #687: 1 = restored from the trash; dropped, the history label would go. */
  restored?: number;
}

export interface RekeyTrashRow {
  path_hash: string;
  head_json: string;
  deleted_by_device: string;
  trashed_at: number;
}

export interface RekeyVersionItem {
  old_path_hash: string;
  row: RekeyVersionRow;
}

export interface RekeyTrashItem {
  old_path_hash: string;
  row: RekeyTrashRow;
}

export interface RekeyTrashEntry {
  path_hash: string;
  trashed_at: number;
  deleted_by_device: string;
  head_json: string;
}

export interface RekeyClient {
  registerAuth(): Promise<void>;
  heads(): Promise<HeadRecord[]>;
  versionChain(pathHash: string): Promise<VersionRecord[]>;
  trash(): Promise<RekeyTrashEntry[]>;
  getBlob(hash: string): Promise<Uint8Array>;
  putBlob(hash: string, body: Uint8Array): Promise<void>;
  startSession(mode: RekeyMode): Promise<void>;
  status(): Promise<{ mode: RekeyMode | null }>;
  postRows(versions: RekeyVersionItem[], trash: RekeyTrashItem[]): Promise<void>;
  switch(
    payload: { verifier: string; argon2_ops: number; argon2_mem: number; auth_hash: string },
  ): Promise<void>;
  cancel(): Promise<void>;
}

// The run's flavor: change keeps the vault's params, re-key moves to the
// chosen level's. Stored in the cursor so a reopened run shows the right
// success line and asks for the right passphrases (#559).
export type RekeyKind = "change" | "rekey";

export interface RekeyCursor {
  kind: RekeyKind;
  mode: RekeyMode;
  ops: number;
  mem: number;
  phase: "blobs" | "rows" | "done";
  blobs_done: number;
}

// Thrown by the worker when the run is aborted (Pause / Cancel / close).
// Branch on the type, not the message (#559 review).
export class RekeyAborted extends Error {
  constructor() {
    super("rekey aborted");
  }
}

export interface RekeyCursorStore {
  load(): RekeyCursor | null;
  save(cursor: RekeyCursor): void;
  clear(): void;
}

export interface RekeyProgress {
  phase: "blobs" | "rows" | "switch";
  done: number;
  total: number;
}

export interface RekeyWorkList {
  chunks: string[];
  versions: VersionRecord[];
  trash: RekeyTrashEntry[];
}

// Deterministic order (path hash, then version) so a resumed run sees the
// same work list; the unique chunk set includes trash-head chunks, which may
// no longer be referenced by any live version.
export function buildWorkList(
  heads: HeadRecord[],
  chains: Record<string, VersionRecord[]>,
  trash: RekeyTrashEntry[],
): RekeyWorkList {
  const versions: VersionRecord[] = [];
  const chunkSet = new Set<string>();
  for (const head of [...heads].sort((a, b) => a.path_hash.localeCompare(b.path_hash))) {
    const chain = (chains[head.path_hash] ?? []).slice().sort((a, b) => a.version - b.version);
    versions.push(...chain);
    for (const v of chain) for (const h of v.chunk_hashes) chunkSet.add(h);
  }
  const sortedTrash = [...trash].sort((a, b) => a.path_hash.localeCompare(b.path_hash));
  for (const t of sortedTrash) {
    const parsed = JSON.parse(t.head_json) as { chunk_hashes?: string[] };
    for (const h of parsed.chunk_hashes ?? []) chunkSet.add(h);
  }
  return { chunks: [...chunkSet].sort(), versions, trash: sortedTrash };
}

// Bounded-concurrency enumeration: heads + trash, then the version chains in
// parallel (default 6). Shared by the choose-phase estimate and the run so
// the work list is fetched once, not twice (#559 review).
export async function enumerateWork(
  client: RekeyClient,
  opts?: { concurrency?: number; signal?: AbortSignal },
): Promise<RekeyWorkList> {
  const concurrency = opts?.concurrency ?? 6;
  const [heads, trash] = await Promise.all([client.heads(), client.trash()]);
  const chains: Record<string, VersionRecord[]> = {};
  let next = 0;
  const pull = async (): Promise<void> => {
    for (;;) {
      if (opts?.signal?.aborted) throw new RekeyAborted();
      const head = heads[next++];
      if (!head) return;
      chains[head.path_hash] = await client.versionChain(head.path_hash);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, heads.length) }, () => pull()));
  return buildWorkList(heads, chains, trash);
}

/** Server row batches for the estimate (the worker posts ROW_BATCH per batch). */
export function rowBatchesOf(work: RekeyWorkList): number {
  return Math.ceil((work.versions.length + work.trash.length) / ROW_BATCH);
}

// New path hash = hashPathHex(new mac_key, meta.path); metadata and path are
// re-encrypted under it. seq/created_at/deleted/chunk_hashes travel verbatim.
export async function rewriteVersionRow(
  record: VersionRecord,
  oldKeys: VaultKeys,
  newKeys: VaultKeys,
): Promise<RekeyVersionItem> {
  const meta = await decryptMetadata(b64decode(record.enc_metadata), oldKeys, record.path_hash);
  const newPathHash = hashPathHex(newKeys.mac_key, meta.path);
  const encMetadata = b64encode(await encryptMetadata(meta, newKeys, newPathHash));
  let pathCiphertext: string | null = null;
  if (record.path_ciphertext) {
    const path = await decryptPath(b64decode(record.path_ciphertext), oldKeys, record.path_hash);
    pathCiphertext = b64encode(await encryptPath(path, newKeys, newPathHash));
  }
  return {
    old_path_hash: record.path_hash,
    row: {
      version: record.version,
      parent: record.parent,
      seq: record.seq,
      path_hash: newPathHash,
      enc_metadata: encMetadata,
      chunk_hashes: JSON.stringify(record.chunk_hashes),
      deleted: record.deleted,
      device_id: record.device_id,
      created_at: record.created_at,
      compacted_range: record.compacted_range,
      path_ciphertext: pathCiphertext,
      rename_mark: record.rename_mark,
      restored: record.restored === true ? 1 : 0,
    },
  };
}

// Trash heads carry the same head_json shape the server writes on delete;
// only enc_metadata / path_ciphertext change keys.
export async function rewriteTrashHead(
  entry: RekeyTrashEntry,
  oldKeys: VaultKeys,
  newKeys: VaultKeys,
): Promise<RekeyTrashItem> {
  const head = JSON.parse(entry.head_json) as {
    version: number;
    parent: number | null;
    chunk_hashes: string[];
    enc_metadata: string;
    path_ciphertext?: string | null;
    deleted: number;
  };
  const meta = await decryptMetadata(b64decode(head.enc_metadata), oldKeys, entry.path_hash);
  const newPathHash = hashPathHex(newKeys.mac_key, meta.path);
  const encMetadata = b64encode(await encryptMetadata(meta, newKeys, newPathHash));
  let pathCiphertext: string | null = null;
  if (head.path_ciphertext) {
    const path = await decryptPath(b64decode(head.path_ciphertext), oldKeys, entry.path_hash);
    pathCiphertext = b64encode(await encryptPath(path, newKeys, newPathHash));
  }
  const headJson = JSON.stringify({
    version: head.version,
    parent: head.parent,
    chunk_hashes: head.chunk_hashes,
    enc_metadata: encMetadata,
    path_ciphertext: pathCiphertext,
    deleted: head.deleted,
  });
  return {
    old_path_hash: entry.path_hash,
    row: {
      path_hash: newPathHash,
      head_json: headJson,
      deleted_by_device: entry.deleted_by_device,
      trashed_at: entry.trashed_at,
    },
  };
}

const ROW_BATCH = 50;
const CURSOR_THROTTLE_MS = 2000;

export interface RekeyOptions {
  kind: RekeyKind;
  oldKeys: VaultKeys;
  newKeys: VaultKeys;
  params: { ops: number; mem: number };
  mode: RekeyMode;
  client: RekeyClient;
  cursor: RekeyCursorStore;
  /** Prebuilt work list (shared with the estimate); built when absent. */
  work?: RekeyWorkList;
  onProgress?: (p: RekeyProgress) => void;
  signal?: AbortSignal;
}

export async function runRekey(opts: RekeyOptions): Promise<{ verifierB64: string }> {
  const { kind, oldKeys, newKeys, params, mode, client, cursor, onProgress, signal } = opts;
  const saved = cursor.load();
  if (saved && (saved.mode !== mode || saved.ops !== params.ops || saved.mem !== params.mem)) {
    throw new Error("rekey cursor is from a different mode/params");
  }
  // Vaults whose devices only ever auto-unlock never registered: do it here.
  if (!saved) await registerAuth(client);
  await ensureSession(client, mode, saved !== null);

  const work = opts.work ?? await enumerateWork(client);

  const state: RekeyCursor = {
    kind,
    mode,
    ops: params.ops,
    mem: params.mem,
    phase: saved?.phase === "rows" ? "rows" : "blobs",
    blobs_done: saved?.phase === "blobs" ? saved.blobs_done : 0,
  };
  const save = makeCursorSaver(cursor, state);
  const checkAbort = () => {
    if (signal?.aborted) {
      save(true);
      throw new RekeyAborted();
    }
  };

  if (state.phase === "rows") state.blobs_done = work.chunks.length;
  else await rekeyBlobs(client, oldKeys, newKeys, work.chunks, state, save, checkAbort, onProgress);
  await rekeyRows(
    client,
    oldKeys,
    newKeys,
    work,
    saved !== null,
    state,
    save,
    checkAbort,
    onProgress,
  );

  onProgress?.({ phase: "switch", done: 0, total: 1 });
  const verifierB64 = await finishSwitch(client, newKeys, params, saved !== null, cursor);
  return { verifierB64 };
}

// Split out of runRekey: inline, the branch pushed it over the complexity gate.
async function registerAuth(client: RekeyClient): Promise<void> {
  try {
    await client.registerAuth();
  } catch (e) {
    if (e instanceof HttpStatusError && (e.status === 401 || e.status === 403)) {
      throw new Error(AUTH_NOT_REGISTERED);
    }
    throw e;
  }
}

async function ensureSession(
  client: RekeyClient,
  mode: RekeyMode,
  resuming: boolean,
): Promise<void> {
  if (resuming) return;
  try {
    await client.startSession(mode);
  } catch (e) {
    // A crash between startSession and the first cursor save leaves an open
    // session with no cursor: join it if it is the same mode.
    if (!(e instanceof HttpStatusError && e.status === 409)) throw e;
    const open = await client.status();
    if (open.mode !== mode) throw new Error(`rekey in progress in mode ${open.mode}`);
  }
}

async function finishSwitch(
  client: RekeyClient,
  newKeys: VaultKeys,
  params: { ops: number; mem: number },
  resuming: boolean,
  cursor: RekeyCursorStore,
): Promise<string> {
  const verifierB64 = b64encode(await makeVerifier(newKeys));
  try {
    await client.switch({
      verifier: verifierB64,
      argon2_ops: params.ops,
      argon2_mem: params.mem,
      auth_hash: authHashHex(deriveAuthKey(newKeys)),
    });
  } catch (e) {
    // A crash between the switch and the cursor clear: the session is already
    // switched (409 "no rekey in progress"): the run is done.
    if (!(resuming && e instanceof HttpStatusError && e.status === 409)) throw e;
  }
  cursor.clear();
  return verifierB64;
}

type SaveCursor = (immediate?: boolean) => void;
type CheckAbort = () => void;

function makeCursorSaver(store: RekeyCursorStore, state: RekeyCursor): SaveCursor {
  let lastSave = 0;
  return (immediate = false) => {
    const now = Date.now();
    if (immediate || now - lastSave >= CURSOR_THROTTLE_MS) {
      store.save({ ...state });
      lastSave = now;
    }
  };
}

async function rekeyBlobs(
  client: RekeyClient,
  oldKeys: VaultKeys,
  newKeys: VaultKeys,
  chunks: string[],
  state: RekeyCursor,
  save: SaveCursor,
  checkAbort: CheckAbort,
  onProgress?: (p: RekeyProgress) => void,
): Promise<void> {
  for (let i = state.blobs_done; i < chunks.length; i++) {
    checkAbort();
    const hash = chunks[i];
    const ct = await client.getBlob(hash);
    let pt: Uint8Array;
    try {
      pt = await decryptChunk(ct, oldKeys, hash);
    } catch {
      // A crash between putBlob and the cursor save: the blob is already
      // re-encrypted. Skip it: re-encrypting the new ciphertext would fail.
      state.blobs_done = i + 1;
      continue;
    }
    await client.putBlob(hash, await encryptChunk(pt, newKeys, hash));
    state.blobs_done = i + 1;
    onProgress?.({ phase: "blobs", done: i + 1, total: chunks.length });
    save();
  }
}

async function rekeyRows(
  client: RekeyClient,
  oldKeys: VaultKeys,
  newKeys: VaultKeys,
  work: RekeyWorkList,
  resuming: boolean,
  state: RekeyCursor,
  save: SaveCursor,
  checkAbort: CheckAbort,
  onProgress?: (p: RekeyProgress) => void,
): Promise<void> {
  state.phase = "rows";
  save(true);
  const total = work.versions.length + work.trash.length;
  let done = 0;
  const batch: { versions: RekeyVersionItem[]; trash: RekeyTrashItem[] } = {
    versions: [],
    trash: [],
  };
  const flush = async (): Promise<void> => {
    if (batch.versions.length === 0 && batch.trash.length === 0) return;
    const versions = batch.versions.splice(0, batch.versions.length);
    const trash = batch.trash.splice(0, batch.trash.length);
    await client.postRows(versions, trash);
  };
  // A batch holds whole chains: the server rewrites a batch in one transaction,
  // so a path is never half-rewritten across a crash boundary (a chain longer
  // than ROW_BATCH travels alone).
  for (const chain of groupChains(work.versions)) {
    checkAbort();
    const items: RekeyVersionItem[] = [];
    for (const record of chain) {
      let item: RekeyVersionItem;
      try {
        item = await rewriteVersionRow(record, oldKeys, newKeys);
      } catch (e) {
        if (!resuming) throw e;
        // Resume in replace mode: the row was already rewritten in place, so it
        // no longer decrypts under the old keys.
        log.warn("rekey: skipping already-rewritten row", { version: record.version });
        done++;
        continue;
      }
      items.push(item);
      done++;
      onProgress?.({ phase: "rows", done, total });
    }
    if (batch.versions.length > 0 && batch.versions.length + items.length > ROW_BATCH) {
      await flush();
    }
    batch.versions.push(...items);
    save();
  }
  for (const entry of work.trash) {
    checkAbort();
    let item: RekeyTrashItem;
    try {
      item = await rewriteTrashHead(entry, oldKeys, newKeys);
    } catch (e) {
      if (!resuming) throw e;
      log.warn("rekey: skipping already-rewritten trash head", { path_hash: entry.path_hash });
      done++;
      continue;
    }
    if (batch.versions.length + batch.trash.length >= ROW_BATCH) await flush();
    batch.trash.push(item);
    done++;
    onProgress?.({ phase: "rows", done, total });
    save();
  }
  await flush();
}

// work.versions is path-grouped (buildWorkList order); recover the chains so a
// batch never splits one path across two server transactions.
function groupChains(versions: VersionRecord[]): VersionRecord[][] {
  const chains: VersionRecord[][] = [];
  for (const record of versions) {
    const last = chains[chains.length - 1];
    if (last && last[0].path_hash === record.path_hash) last.push(record);
    else chains.push([record]);
  }
  return chains;
}
