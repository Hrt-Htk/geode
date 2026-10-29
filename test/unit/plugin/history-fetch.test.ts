import { assertEquals } from "@std/assert";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../../core/crypto.ts";
import { hashPathHex } from "../../../core/hash.ts";
import {
  b64encode,
  type FileMeta,
  RENAME_MARKER,
  RENAME_NOTE,
  type VersionRecord,
} from "../../../core/protocol.ts";
import {
  eraseChain,
  fetchVersionPage,
  HistoryWalk,
  saveKey,
} from "../../../plugin/sync/history-fetch.ts";
import {
  HttpClient,
  setTransportHttp,
  type TransportHttpRequest,
  type TransportHttpResponse,
} from "../../../plugin/sync/http-client.ts";

// #463: "Show older" pagination over the real client. The stub answers like
// the server route: `version <= up_to` ORDER BY version DESC LIMIT 100.
// Every test here installs its own stub (module-scoped, no restore needed).

const SERVER_PAGE = 100;
const PATH_HASH = "a".repeat(64);

function versionRecord(version: number): VersionRecord {
  return {
    version,
    parent: version === 1 ? null : version - 1,
    path_hash: PATH_HASH,
    chunk_hashes: [],
    enc_metadata: "",
    compacted_range: null,
    path_ciphertext: null,
    device_id: "dev-1",
    seq: version,
    created_at: 1_700_000_000_000 + version,
    deleted: 0,
  };
}

function jsonResponse(body: unknown): TransportHttpResponse {
  return {
    status: 200,
    ok: true,
    text: () => JSON.stringify(body),
    arrayBuffer: () => new ArrayBuffer(0),
  };
}

/** Installs a transport stub over `total` versions and records request URLs. */
function stubChain(total: number): string[] {
  const urls: string[] = [];
  const rows: VersionRecord[] = [];
  for (let v = total; v >= 1; v--) rows.push(versionRecord(v));
  setTransportHttp((req: TransportHttpRequest) => {
    urls.push(req.url);
    const url = new URL(req.url);
    const upTo = url.searchParams.has("up_to") ? Number(url.searchParams.get("up_to")) : Infinity;
    const page = rows.filter((r) => r.version <= upTo).slice(0, SERVER_PAGE);
    return Promise.resolve(jsonResponse(page));
  });
  return urls;
}

Deno.test("history-fetch - pages a long chain newest-first, one page per call", async () => {
  const urls = stubChain(250);
  const http = new HttpClient("http://stub", "vault-1", "token");

  const page1 = await fetchVersionPage(http, PATH_HASH);
  assertEquals(page1.versions.length, SERVER_PAGE);
  assertEquals(page1.versions[0].version, 250);
  assertEquals(page1.versions.at(-1)!.version, 151);
  assertEquals(page1.nextUpTo, 150);
  assertEquals(new URL(urls[0]).searchParams.has("up_to"), false, "first page sends no cursor");

  const page2 = await fetchVersionPage(http, PATH_HASH, page1.nextUpTo!);
  assertEquals(page2.versions.length, SERVER_PAGE);
  assertEquals(page2.versions[0].version, 150);
  assertEquals(page2.versions.at(-1)!.version, 51);
  assertEquals(page2.nextUpTo, 50);
  assertEquals(new URL(urls[1]).searchParams.get("up_to"), "150");

  const page3 = await fetchVersionPage(http, PATH_HASH, page2.nextUpTo!);
  assertEquals(page3.versions.length, 50);
  assertEquals(page3.versions[0].version, 50);
  assertEquals(page3.versions.at(-1)!.version, 1);
  assertEquals(page3.nextUpTo, null, "last page has no older cursor");
  assertEquals(urls.length, 3);
});

Deno.test("history-fetch - an exactly-full page is the last page when version 1 is on it", async () => {
  stubChain(100);
  const http = new HttpClient("http://stub", "vault-1", "token");
  const page = await fetchVersionPage(http, PATH_HASH);
  assertEquals(page.versions.length, 100);
  assertEquals(page.versions.at(-1)!.version, 1);
  assertEquals(page.nextUpTo, null);
});

Deno.test("history-fetch - an unknown path returns an empty page, not an error", async () => {
  stubChain(0);
  const http = new HttpClient("http://stub", "vault-1", "token");
  const page = await fetchVersionPage(http, PATH_HASH);
  assertEquals(page.versions, []);
  assertEquals(page.nextUpTo, null);
});

/* ---------------------------------------------------------------------------
 * #583: the walk across renames. Each name is one segment; a segment ends at its
 * note (the name's first version, carrying `renamed_from`), and the rows below the
 * note belong to an earlier file that reused the name. Markers (the old name's
 * closing version) are links, never content.
 * ------------------------------------------------------------------------- */

const SALT = new Uint8Array(16).fill(0x51);
const A = "Notes/A.md";
const B = "Notes/B.md";

async function vaultKeys(): Promise<VaultKeys> {
  return await deriveKeys("history-fetch-walk-pass", SALT);
}

type RowSpec = {
  mark?: number;
  from?: string;
  fromVersion?: number;
  to?: string;
  deleted?: boolean;
  compacted?: string;
};

function chainRow(
  keys: VaultKeys,
  path: string,
  version: number,
  spec: RowSpec,
): Promise<VersionRecord> {
  return (async () => {
    const pathHash = hashPathHex(keys.mac_key, path);
    const meta: FileMeta = {
      path,
      mtime: 1,
      size: 0,
      mime: "text/markdown",
      plaintext_hash: "plaintext",
      ...(spec.from === undefined ? {} : { renamed_from: spec.from }),
      ...(spec.from === undefined ? {} : { renamed_from_version: spec.fromVersion ?? 0 }),
      ...(spec.to === undefined ? {} : { renamed_to: spec.to }),
    };
    return {
      version,
      parent: version === 1 ? null : version - 1,
      path_hash: pathHash,
      chunk_hashes: [],
      enc_metadata: b64encode(await encryptMetadata(meta, keys, pathHash)),
      compacted_range: spec.compacted ?? null,
      path_ciphertext: null,
      device_id: "dev-1",
      seq: version,
      created_at: 1_700_000_000_000 + version,
      deleted: spec.deleted ? 1 : 0,
      rename_mark: spec.mark ?? 0,
    };
  })();
}

/** Fixture rows, keyed the way the server keys them: by path hash. */
function put(
  chains: Map<string, VersionRecord[]>,
  keys: VaultKeys,
  path: string,
  rows: VersionRecord[],
): void {
  chains.set(hashPathHex(keys.mac_key, path), rows);
}

/** An in-memory /versions route: `version <= up_to`, newest first, 100 a page. */
function pageSource(chains: Map<string, VersionRecord[]>) {
  const calls: Array<{ pathHash: string; upTo?: number }> = [];
  return {
    calls,
    getVersionChain: (pathHash: string, upTo?: number): Promise<VersionRecord[]> => {
      calls.push({ pathHash, upTo });
      const cap = upTo ?? Infinity;
      return Promise.resolve(
        (chains.get(pathHash) ?? [])
          .filter((row) => row.version <= cap)
          .sort((x, y) => y.version - x.version)
          .slice(0, SERVER_PAGE),
      );
    },
  };
}

const versionsOf = (rows: VersionRecord[]) => rows.map((row) => row.version);
const marksOf = (rows: VersionRecord[]) => rows.map((row) => row.rename_mark);

/** A gen1 / marker / A gen2 / B / A gen3: the file came back to A twice. */
async function reuseFixture() {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  const a = [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, {}),
    await chainRow(keys, A, 3, { mark: RENAME_MARKER, to: "Notes/Gone.md", deleted: true }),
    await chainRow(keys, A, 4, {}),
    await chainRow(keys, A, 5, {}),
    await chainRow(keys, A, 6, { mark: RENAME_MARKER, to: B, deleted: true }),
    await chainRow(keys, A, 7, { mark: RENAME_NOTE, from: B, fromVersion: 3 }),
    await chainRow(keys, A, 8, {}),
  ];
  const b = [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 6 }),
    await chainRow(keys, B, 2, {}),
    await chainRow(keys, B, 3, { mark: RENAME_MARKER, to: A, deleted: true }),
  ];
  put(chains, keys, A, a);
  put(chains, keys, B, b);
  return { keys, chains };
}

async function drain(walk: HistoryWalk): Promise<HistoryWalk> {
  while (!walk.done) await walk.next();
  return walk;
}

Deno.test("history-walk - a reused name stops at the older generation's marker", async () => {
  const { keys, chains } = await reuseFixture();
  const source = pageSource(chains);
  const walk = await drain(new HistoryWalk(source, keys, hashPathHex(keys.mac_key, A)));

  assertEquals(
    walk.segments.map((segment) => versionsOf(segment.versions)),
    [[8, 7], [2, 1], [5, 4]],
    "newest generation first; the pre-marker generation (1, 2) never shows",
  );
  assertEquals(walk.segments.map((segment) => segment.from), [B, A, null]);
  assertEquals(
    walk.chain,
    [
      { path_hash: hashPathHex(keys.mac_key, B), up_to: 3 },
      { path_hash: hashPathHex(keys.mac_key, A), up_to: 6 },
    ],
    "#582 needs every name the walk crossed, the one visited twice included; the open-ended " +
      "newest generation has no ceiling",
  );
  for (const segment of walk.segments) {
    assertEquals(marksOf(segment.versions).includes(RENAME_MARKER), false, "no marker is content");
  }
  assertEquals(source.calls.map((call) => call.upTo), [undefined, 3, 6]);
});

Deno.test("history-walk - chain carries every name with its ceiling (#582)", async () => {
  const { keys, chains } = await reuseFixture();
  const source = pageSource(chains);
  const walk = await drain(new HistoryWalk(source, keys, hashPathHex(keys.mac_key, B), 3));

  assertEquals(walk.chain, [
    { path_hash: hashPathHex(keys.mac_key, B), up_to: 3 },
    { path_hash: hashPathHex(keys.mac_key, A), up_to: 6 },
  ], "delete forever erases each name up to the marker that closed it");
  assertEquals(
    await eraseChain(source, keys, hashPathHex(keys.mac_key, B), 3),
    walk.chain,
    "eraseChain is the whole window, drained",
  );
});

Deno.test("history-walk - an uncapped read has no ceiling to send", async () => {
  const { keys, chains } = await reuseFixture();
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, A)));

  assertEquals(walk.chain, [
    { path_hash: hashPathHex(keys.mac_key, B), up_to: 3 },
    { path_hash: hashPathHex(keys.mac_key, A), up_to: 6 },
  ], "the open-ended newest generation is not a ceiling delete forever may use");
});

Deno.test("history-walk - a ceiling opens the window at that version", async () => {
  const { keys, chains } = await reuseFixture();
  const source = pageSource(chains);
  const walk = await drain(new HistoryWalk(source, keys, hashPathHex(keys.mac_key, B), 3));

  assertEquals(versionsOf(walk.segments[0].versions), [2, 1]);
  assertEquals(walk.segments[0].from, A);
  assertEquals(versionsOf(walk.segments[1].versions), [5, 4], "the cap bounds the second name");
  assertEquals(source.calls[0].upTo, 3);
});

Deno.test("history-walk - a zero cap means the newest marker on the old name's head page", async () => {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, {}),
    await chainRow(keys, A, 3, { mark: RENAME_MARKER, to: B, deleted: true }),
    await chainRow(keys, A, 4, {}),
  ]);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 0 }),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, B)));

  assertEquals(versionsOf(walk.segments[1].versions), [2, 1]);
  assertEquals(walk.segments[1].pathHash, hashPathHex(keys.mac_key, A));
});

Deno.test("history-walk - two names pointing at each other stop", async () => {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [
    await chainRow(keys, A, 1, { mark: RENAME_NOTE, from: B, fromVersion: 1 }),
  ]);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 1 }),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, A)));

  assertEquals(walk.segments.length, 3);
  assertEquals(walk.segments.at(-1)!.from, B, "the last row of a cycle names a name already read");
});

Deno.test("history-walk - the depth cap stops a long chain of names", async () => {
  const keys = await vaultKeys();
  const paths = Array.from({ length: 25 }, (_, i) => `Notes/step${i}.md`);
  const chains = new Map<string, VersionRecord[]>();
  for (let i = 0; i < paths.length; i++) {
    const first = i === 0
      ? await chainRow(keys, paths[i], 1, {})
      : await chainRow(keys, paths[i], 1, {
        mark: RENAME_NOTE,
        from: paths[i - 1],
        fromVersion: 2,
      });
    const rows = [first];
    rows.push(
      i === paths.length - 1
        ? await chainRow(keys, paths[i], 2, {})
        : await chainRow(keys, paths[i], 2, {
          mark: RENAME_MARKER,
          to: paths[i + 1],
          deleted: true,
        }),
    );
    put(chains, keys, paths[i], rows);
  }
  const walk = await drain(
    new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, paths[24])),
  );

  assertEquals(walk.segments.length, 20, "at most 20 names per window");
});

Deno.test("history-walk - a generation longer than one page loads one page at a time", async () => {
  const keys = await vaultKeys();
  const rows: VersionRecord[] = [];
  for (let version = 150; version >= 1; version--) rows.push(await chainRow(keys, A, version, {}));
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, rows);
  const source = pageSource(chains);
  const walk = new HistoryWalk(source, keys, hashPathHex(keys.mac_key, A));

  await walk.next();
  assertEquals(walk.segments[0].versions.length, SERVER_PAGE, "the modal opens on one page");
  assertEquals(walk.done, false);

  await walk.next();
  assertEquals(walk.segments[0].versions.length, 150);
  assertEquals(walk.done, true);
  assertEquals(walk.segments.length, 1, "one name, one page cursor, no second segment");
});

Deno.test("history-walk - an uncapped open of a renamed-away name lists its own saves", async () => {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, {}),
    await chainRow(keys, A, 3, { mark: RENAME_MARKER, to: B, deleted: true }),
  ]);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 3 }),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, A)));

  // The name's head is the marker that renamed it away (an activity row's History
  // opens that name uncapped): its saves sit under the marker, not nowhere.
  assertEquals(walk.segments.map((segment) => versionsOf(segment.versions)), [[2, 1]]);
  assertEquals(walk.done, true);
});

Deno.test("history-walk - a zero cap picks the old name's marker, not a later reuse", async () => {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, {}),
    await chainRow(keys, A, 3, { mark: RENAME_MARKER, to: B, deleted: true }),
    await chainRow(keys, A, 4, {}),
    await chainRow(keys, A, 5, {}),
    await chainRow(keys, A, 6, { mark: RENAME_MARKER, to: "Notes/Elsewhere.md", deleted: true }),
  ]);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 0 }),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, B)));

  assertEquals(versionsOf(walk.segments[0].versions), [1]);
  assertEquals(
    versionsOf(walk.segments[1].versions),
    [2, 1],
    "a zero cap means the marker of the note's own rename, not the later reuse's",
  );
});

Deno.test("history-walk - a zero cap past two reuses on one page finds the note's own marker", async () => {
  // #606: the note's own marker is two generations below the head page, so the
  // oldest marker still on that page is a *later* reuse's boundary.
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  const a: VersionRecord[] = [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, {}),
    await chainRow(keys, A, 3, { mark: RENAME_MARKER, to: "Notes/Gone.md", deleted: true }),
    await chainRow(keys, A, 4, {}),
    await chainRow(keys, A, 5, {}),
    await chainRow(keys, A, 6, { mark: RENAME_MARKER, to: "Notes/Elsewhere.md", deleted: true }),
    await chainRow(keys, A, 7, {}),
    await chainRow(keys, A, 8, {}),
    // The marker the note on B means: it renamed A to B.
    await chainRow(keys, A, 9, { mark: RENAME_MARKER, to: B, deleted: true }),
  ];
  for (let version = 10; version <= 16; version++) a.push(await chainRow(keys, A, version, {}));
  a.push(await chainRow(keys, A, 17, { mark: RENAME_MARKER, to: "Notes/Third.md", deleted: true }));
  for (let version = 18; version <= 115; version++) a.push(await chainRow(keys, A, version, {}));
  a.push(
    await chainRow(keys, A, 116, { mark: RENAME_MARKER, to: "Notes/Fourth.md", deleted: true }),
  );
  put(chains, keys, A, a);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 0 }),
    await chainRow(keys, B, 2, {}),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, B)));

  assertEquals(
    walk.segments.map((segment) => versionsOf(segment.versions)),
    [[2, 1], [8, 7]],
    "the note's own generation, not a later file that reused the name",
  );
  assertEquals(walk.segments[1].from, null, "A's first generation was the original file");
});

Deno.test("history-walk - a zero cap with no marker pointing at the note ends the walk", async () => {
  // A dangling link (#615's lost middle name, a purged marker): the name's rows belong
  // to another file, so showing any of them under "Renamed from" would be a guess.
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [
    await chainRow(keys, A, 1, {}),
    await chainRow(keys, A, 2, { mark: RENAME_MARKER, to: "Notes/Elsewhere.md", deleted: true }),
    await chainRow(keys, A, 3, {}),
    await chainRow(keys, A, 4, { mark: RENAME_MARKER, to: "Notes/Third.md", deleted: true }),
  ]);
  put(chains, keys, B, [
    await chainRow(keys, B, 1, { mark: RENAME_NOTE, from: A, fromVersion: 0 }),
  ]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, B)));

  assertEquals(walk.segments.map((segment) => versionsOf(segment.versions)), [[1]]);
  assertEquals(walk.done, true);
});

Deno.test("history-walk - a long generation does not spend the name budget", async () => {
  const keys = await vaultKeys();
  const paths = Array.from({ length: 20 }, (_, i) => `Notes/long${i}.md`);
  const chains = new Map<string, VersionRecord[]>();
  for (let i = 0; i < paths.length; i++) {
    const note = i === 0 ? {} : { mark: RENAME_NOTE, from: paths[i - 1], fromVersion: 2 };
    if (i === paths.length - 1) {
      // The head name spans two server pages; its oldest version is its note.
      const rows = [await chainRow(keys, paths[i], 1, note)];
      for (let version = 2; version <= 150; version++) {
        rows.push(await chainRow(keys, paths[i], version, {}));
      }
      put(chains, keys, paths[i], rows);
      continue;
    }
    put(chains, keys, paths[i], [
      await chainRow(keys, paths[i], 1, note),
      await chainRow(keys, paths[i], 2, { mark: RENAME_MARKER, to: paths[i + 1], deleted: true }),
    ]);
  }
  const walk = await drain(
    new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, paths[19])),
  );

  assertEquals(walk.segments.length, 20, "two pages of one name, twenty names in the window");
});

Deno.test("history-walk - rows, record and opensWithHistory read the loaded window", async () => {
  const { keys, chains } = await reuseFixture();
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, A)));
  const bHash = hashPathHex(keys.mac_key, B);

  assertEquals(versionsOf(walk.rows()), [8, 7, 2, 1, 5, 4], "every name, newest first");
  assertEquals(walk.record(saveKey(bHash, 2))?.version, 2, "a key names one name's save");
  assertEquals(walk.record(saveKey(hashPathHex(keys.mac_key, A), 8))?.version, 8);
  assertEquals(walk.record(saveKey(bHash, 8)), null, "a version from another name is not this one");
  assertEquals(walk.opensWithHistory(), true);
});

Deno.test("history-walk - one save and no older name opens on the empty state", async () => {
  const keys = await vaultKeys();
  const chains = new Map<string, VersionRecord[]>();
  put(chains, keys, A, [await chainRow(keys, A, 1, {})]);
  const walk = await drain(new HistoryWalk(pageSource(chains), keys, hashPathHex(keys.mac_key, A)));

  assertEquals(walk.rows().length, 1);
  assertEquals(walk.opensWithHistory(), false, "one version, nothing older to show");
});
