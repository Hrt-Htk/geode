import { assert, assertEquals, assertRejects } from "@std/assert";
import { b64encode } from "../../../core/protocol.ts";
import type { HeadRecord, VersionRecord } from "../../../core/protocol.ts";
import {
  buildWorkList,
  enumerateWork,
  RekeyAborted,
  type RekeyClient,
  type RekeyTrashEntry,
  rowBatchesOf,
} from "../../../plugin/sync/rekey-run.ts";

function head(pathHash: string): HeadRecord {
  return {
    path_hash: pathHash,
    version: 1,
    seq: 1,
    enc_metadata: b64encode(new Uint8Array(0)),
    chunk_hashes: [`chunk-${pathHash}`],
    deleted: false,
    path_ciphertext: null,
  };
}

function row(pathHash: string, version: number): VersionRecord {
  return {
    version,
    parent: version - 1 === 0 ? null : version - 1,
    path_hash: pathHash,
    chunk_hashes: [`chunk-${pathHash}`],
    enc_metadata: b64encode(new Uint8Array(0)),
    compacted_range: null,
    path_ciphertext: null,
    device_id: "d",
    seq: version,
    created_at: version,
    deleted: 0,
  };
}

type FakeClient = RekeyClient & {
  inFlight: number;
  maxInFlight: number;
  chainDelayMs: number;
};

function fakeClient(heads: HeadRecord[], chainDelayMs = 0): FakeClient {
  const client = {
    inFlight: 0,
    maxInFlight: 0,
    chainDelayMs,
    registerAuth: async () => {},
    heads: () => Promise.resolve(heads),
    versionChain: async (pathHash: string) => {
      client.inFlight++;
      client.maxInFlight = Math.max(client.maxInFlight, client.inFlight);
      if (client.chainDelayMs > 0) await new Promise((r) => setTimeout(r, client.chainDelayMs));
      client.inFlight--;
      return [row(pathHash, 1)];
    },
    trash: (): Promise<RekeyTrashEntry[]> => Promise.resolve([]),
    getBlob: () => Promise.resolve(new Uint8Array()),
    putBlob: async () => {},
    startSession: async () => {},
    status: () => Promise.resolve({ mode: null }),
    postRows: async () => {},
    switch: async () => {},
    cancel: async () => {},
  } as FakeClient;
  return client;
}

Deno.test("enumerateWork - builds the same work list as buildWorkList", async () => {
  const heads = [head("aa"), head("bb"), head("cc")];
  const client = fakeClient(heads);
  const work = await enumerateWork(client);
  const chains: Record<string, VersionRecord[]> = {};
  for (const h of heads) chains[h.path_hash] = [row(h.path_hash, 1)];
  assertEquals(work, buildWorkList(heads, chains, []));
});

Deno.test("enumerateWork - bounded concurrency (default 6)", async () => {
  const heads = Array.from({ length: 20 }, (_, i) => head(`h${String(i).padStart(2, "0")}`));
  const client = fakeClient(heads, 5);
  await enumerateWork(client);
  assert(client.maxInFlight <= 6, `max in flight ${client.maxInFlight} exceeds 6`);
  assert(client.maxInFlight > 1, "expected parallel chain fetches");
});

Deno.test("enumerateWork - explicit concurrency is honored", async () => {
  const heads = Array.from({ length: 10 }, (_, i) => head(`h${i}`));
  const client = fakeClient(heads, 5);
  await enumerateWork(client, { concurrency: 2 });
  assert(client.maxInFlight <= 2, `max in flight ${client.maxInFlight} exceeds 2`);
});

Deno.test("enumerateWork - abort throws RekeyAborted", async () => {
  const heads = Array.from({ length: 10 }, (_, i) => head(`h${i}`));
  const client = fakeClient(heads, 5);
  const ac = new AbortController();
  ac.abort();
  await assertRejects(
    () => enumerateWork(client, { signal: ac.signal }),
    RekeyAborted,
  );
});

Deno.test("rowBatchesOf - ceil of rows over the batch size", () => {
  const work = (n: number) => ({
    chunks: [],
    versions: Array.from({ length: n }, (_, i) => row("p", i + 1)),
    trash: [],
  });
  assertEquals(rowBatchesOf(work(0)), 0);
  assertEquals(rowBatchesOf(work(1)), 1);
  assertEquals(rowBatchesOf(work(50)), 1);
  assertEquals(rowBatchesOf(work(51)), 2);
  assertEquals(rowBatchesOf(work(100)), 2);
});
