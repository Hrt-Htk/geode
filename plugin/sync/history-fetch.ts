import {
  b64decode,
  type FileMeta,
  RENAME_MARKER,
  RENAME_NOTE,
  type VersionRecord,
} from "../../core/protocol.ts";
import { decryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import { hashPathHex } from "../../core/hash.ts";
import { reassemble } from "../../core/reassemble.ts";

/** The server caps /versions pages at this many rows (ORDER BY version DESC LIMIT 100). */
const VERSION_PAGE_SIZE = 100;

/** #583: names per window. A deep chain of renames is a loop, not a history. */
const MAX_SEGMENTS = 20;

export interface VersionChainPage {
  /** Newest first, at most one server page. */
  versions: VersionRecord[];
  /** `upTo` cursor for the next (older) page; null when the chain is exhausted. */
  nextUpTo: number | null;
}

/** The versions route, as the unlocked client exposes it. */
export interface HistorySource {
  getVersionChain(pathHash: string, upTo?: number): Promise<VersionRecord[]>;
}

/** One page of a file's version chain. Pass the previous page's `nextUpTo` back
 * in to load older versions ("Show older"); `undefined` loads the newest page. */
export async function fetchVersionPage(
  source: HistorySource,
  pathHash: string,
  upTo?: number,
): Promise<VersionChainPage> {
  const versions = await source.getVersionChain(pathHash, upTo);
  const oldest = versions.at(-1);
  // A short page means the chain ended; version 1 is the first version ever.
  if (!oldest || versions.length < VERSION_PAGE_SIZE || oldest.version <= 1) {
    return { versions, nextUpTo: null };
  }
  return { versions, nextUpTo: oldest.version - 1 };
}

/** Reconstruct one past version's plaintext: the same decrypt + reassemble path
 * `apply` runs for the current version. Throws (blob missing, integrity mismatch)
 * rather than returning partial content. */
export async function reconstructVersion(
  record: VersionRecord,
  keys: VaultKeys,
  getBlob: (hash: string) => Promise<Uint8Array>,
): Promise<{ meta: FileMeta; bytes: Uint8Array }> {
  const meta = await decryptMetadata(b64decode(record.enc_metadata), keys, record.path_hash);
  const bytes = await reassemble(record.chunk_hashes, keys, getBlob, meta.plaintext_hash);
  return { meta, bytes };
}

/** A name in the window's past: the rows to read, and the row they may stop at.
 * `ceiling` 0 means the marker that closed the note's own generation: a note
 * committed before its own marker's ack landed does not know its version. */
type HistoryLink = {
  pathHash: string;
  ceiling: number | null;
  /** The path of the note that links here: a zero cap finds its marker by it. */
  notePath?: string;
};

/** Where the walk is: a name (with its cap), and the page cursor inside it. */
type HistoryCursor = { link: HistoryLink; upTo?: number };

/** One generation of a file at one name, newest first (#583). */
export type HistorySegment = {
  pathHash: string;
  /** The name this generation came from (read off its note); null for the first. */
  from: string | null;
  /** The version this generation ends at; null when the window opened on the name's
   * own head (#582: delete forever needs a ceiling for every name it erases). */
  ceiling: number | null;
  versions: VersionRecord[];
};

type HistoryPage = {
  pathHash: string;
  /** Content rows only: rename markers are links, never saves. */
  versions: VersionRecord[];
  /** The resolved ceiling of this name, null when the window is open-ended. */
  ceiling: number | null;
  /** Older rows of this same name; null once the generation is read. */
  nextUpTo: number | null;
  /** The name this generation came from, once this page carried its note. */
  from: string | null;
  /** The name this page's note links to, before the loop and depth guards. */
  older: HistoryLink | null;
};

/** Read one page of the walk. */
async function fetchHistoryPage(
  source: HistorySource,
  keys: VaultKeys,
  cursor: HistoryCursor,
): Promise<HistoryPage> {
  const cap = cursor.upTo ?? await resolveCap(source, keys, cursor.link);
  const page = await fetchVersionPage(source, cursor.link.pathHash, cap);
  const cut = await cutPage(page.versions, keys, cursor.link.pathHash, cap);
  return {
    pathHash: cursor.link.pathHash,
    versions: cut.versions,
    ceiling: cap ?? null,
    nextUpTo: cut.ended ? null : page.nextUpTo,
    from: cut.from,
    older: cut.older,
  };
}

/** The cap a link names: its marker version, or the marker a zero cap left off. */
async function resolveCap(
  source: HistorySource,
  keys: VaultKeys,
  link: HistoryLink,
): Promise<number | undefined> {
  if (link.ceiling === null) return undefined;
  if (link.ceiling > 0) return link.ceiling;
  return await noteMarker(source, keys, link);
}

/** The marker a zero cap means: the newest one on the old name that renamed a file to
 * the note's own path. Its version was unknown when the note was written (the ack had
 * not landed, which is why the marker landed *after* it), so no seq/created_at bound
 * can find it, and the name may have been reused several times since: the marker can
 * sit pages below the head. 0 = a dangling link: end the walk rather than show rows
 * that belong to a later file. */
async function noteMarker(
  source: HistorySource,
  keys: VaultKeys,
  link: HistoryLink,
): Promise<number> {
  const notePath = link.notePath;
  if (notePath === undefined) return 0;
  let upTo: number | undefined;
  for (;;) {
    const page = await fetchVersionPage(source, link.pathHash, upTo);
    for (const row of page.versions) {
      if (row.rename_mark !== RENAME_MARKER) continue;
      const meta = await decryptMetadata(b64decode(row.enc_metadata), keys, link.pathHash);
      if (meta.renamed_to === notePath) return row.version;
    }
    if (page.nextUpTo === null) return 0;
    upTo = page.nextUpTo;
  }
}

/** One page → the rows this generation owns, and the link to the one before it. */
async function cutPage(
  rows: VersionRecord[],
  keys: VaultKeys,
  pathHash: string,
  cap: number | undefined,
): Promise<
  { versions: VersionRecord[]; from: string | null; older: HistoryLink | null; ended: boolean }
> {
  const versions: VersionRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rename_mark === RENAME_MARKER) {
      // The marker a jump landed on is this generation's boundary; any other marker
      // closed a file that reused the name, so nothing below it is ours.
      if (row.version === cap) continue;
      // An uncapped read opens on the name's own head, where the marker that renamed
      // the name away sits above its saves: those saves are the history asked for.
      if (i === 0 && cap === undefined) continue;
      return { versions, from: null, older: null, ended: true };
    }
    versions.push(row);
    if (row.rename_mark !== RENAME_NOTE) continue;
    const meta = await decryptMetadata(b64decode(row.enc_metadata), keys, pathHash);
    return {
      versions,
      from: meta.renamed_from ?? null,
      older: meta.renamed_from === undefined ? null : {
        pathHash: hashPathHex(keys.mac_key, meta.renamed_from),
        ceiling: meta.renamed_from_version ?? 0,
        notePath: meta.path,
      },
      ended: true,
    };
  }
  return { versions, from: null, older: null, ended: false };
}

/** A generation's identity for the cycle guard: revisiting a name is only a cycle
 * when it reads the same rows. */
function linkKey(link: HistoryLink): string {
  return `${link.pathHash}:${link.ceiling ?? "newest"}`;
}

/** "hex:12": one save's identity in the window; a version number repeats from
 * name to name (#583). */
export function saveKey(pathHash: string, version: number): string {
  return `${pathHash}:${version}`;
}

/** #583: one file's window across renames, one page at a time. The modal asks for
 * a page per "Show older"; #582 needs `chain` to erase a whole history. */
export class HistoryWalk {
  /** The names read so far, newest generation first. */
  readonly segments: HistorySegment[] = [];
  private cursor: HistoryCursor | null;
  private readonly visited = new Set<string>();

  constructor(
    private readonly source: HistorySource,
    private readonly keys: VaultKeys,
    pathHash: string,
    ceiling?: number,
  ) {
    this.cursor = { link: { pathHash, ceiling: ceiling ?? null } };
  }

  get done(): boolean {
    return this.cursor === null;
  }

  /** #582: every name this file lived at with the ceiling it ends at: what delete
   * forever sends. A name read to its own head has no ceiling, so it is left out. */
  get chain(): Array<{ path_hash: string; up_to: number }> {
    return this.segments.flatMap((segment) =>
      segment.ceiling === null ? [] : [{ path_hash: segment.pathHash, up_to: segment.ceiling }]
    );
  }

  /** Every loaded save, newest generation first. */
  rows(): VersionRecord[] {
    return this.segments.flatMap((segment) => segment.versions);
  }

  /** The save behind a `saveKey`, or null once it is out of the window. */
  record(key: string): VersionRecord | null {
    return this.rows().find((row) => saveKey(row.path_hash, row.version) === key) ?? null;
  }

  /** A name behind a marker is history even when this name has one version. */
  opensWithHistory(): boolean {
    return this.rows().length > 1 || !this.done;
  }

  /** Read the next page: older rows of this name, or the name it came from. */
  async next(): Promise<void> {
    const cursor = this.cursor;
    if (!cursor) return;
    const page = await fetchHistoryPage(this.source, this.keys, cursor);
    const segment = this.segments.at(-1);
    if (cursor.upTo === undefined) {
      if (page.versions.length > 0) {
        this.segments.push({
          pathHash: page.pathHash,
          from: page.from,
          ceiling: page.ceiling,
          versions: page.versions,
        });
      }
    } else {
      segment?.versions.push(...page.versions);
      // The note sits at the oldest end of its generation, so the link is only
      // read on the last page of it.
      if (segment && page.from !== null) segment.from = page.from;
    }
    this.visited.add(linkKey(cursor.link));
    this.cursor = this.nextCursor(cursor, page);
  }

  /** The name before this one, unless it loops the walk or the window is full;
   * otherwise the rest of this name. */
  private nextCursor(cursor: HistoryCursor, page: HistoryPage): HistoryCursor | null {
    const older = page.older;
    if (older && !this.visited.has(linkKey(older)) && this.segments.length < MAX_SEGMENTS) {
      return { link: older };
    }
    return page.nextUpTo === null ? null : { link: cursor.link, upTo: page.nextUpTo };
  }
}

/** #582: the whole window, drained: the names a file lived at with the ceiling of
 * each, which is what "Delete forever" erases. `ceiling` is the trashed row's own
 * version (its History is capped at the marker, #583 decision 6). */
export async function eraseChain(
  source: HistorySource,
  keys: VaultKeys,
  pathHash: string,
  ceiling: number,
): Promise<Array<{ path_hash: string; up_to: number }>> {
  const walk = new HistoryWalk(source, keys, pathHash, ceiling);
  while (!walk.done) await walk.next();
  return walk.chain;
}
