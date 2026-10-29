import { assert, assertEquals } from "@std/assert";
import { b64encode, type HeadRecord, type VersionRecord } from "../../../core/protocol.ts";
import { getRecentLog, type LogEntry } from "../../../plugin/plumbing/log.ts";
import { enumerateWork, type RekeyClient } from "../../../plugin/sync/rekey-run.ts";
import { traceListing } from "../../../plugin/ui/rekey-estimate-trace.ts";

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

function row(pathHash: string): VersionRecord {
  return {
    version: 1,
    parent: null,
    path_hash: pathHash,
    chunk_hashes: [`chunk-${pathHash}`],
    enc_metadata: b64encode(new Uint8Array(0)),
    compacted_range: null,
    path_ciphertext: null,
    device_id: "d",
    seq: 1,
    created_at: 1,
    deleted: 0,
  };
}

function listingClient(files: number): RekeyClient {
  const heads = Array.from({ length: files }, (_, i) => head(`p${i}`));
  return {
    heads: () => heads,
    versionChain: async (pathHash: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return [row(pathHash)];
    },
    trash: () => [
      {
        path_hash: "t1",
        head_json: JSON.stringify({ chunk_hashes: [] }),
        deleted_by_device: "d",
        trashed_at: 1,
      },
    ],
  } as unknown as RekeyClient;
}

/** This run's estimate lines: from the newest "file list" on, so a line an
 *  earlier test logged in the same millisecond is never read. */
function estimateLog(since: number): LogEntry[] {
  const lines = getRecentLog().filter((e) => e.ts >= since && e.msg.startsWith("rekey estimate:"));
  return lines.slice(lines.findLastIndex((e) => e.msg === "rekey estimate: file list"));
}

Deno.test("rekey estimate trace - listing logs file list, trash, progress and totals (#571)", async () => {
  const since = Date.now();
  await enumerateWork(traceListing(listingClient(40)));
  const lines = estimateLog(since);
  const byMsg = (m: string) => lines.filter((e) => e.msg === `rekey estimate: ${m}`);

  assertEquals(byMsg("file list")[0]?.fields.files, 40);
  assertEquals(byMsg("trash")[0]?.fields.entries, 1);
  const progress = byMsg("file histories");
  assert(progress.length >= 5 && progress.length <= 10, `progress lines ${progress.length}`);
  const done = progress.map((e) => e.fields.done as number);
  assertEquals(done, [...done].sort((a, b) => a - b));
  const totals = byMsg("file histories done")[0];
  assertEquals(totals?.fields.files, 40);
  for (const k of ["wall_ms", "avg_request_ms", "slowest_request_ms"]) {
    assert(typeof totals?.fields[k] === "number", `${k} = ${totals?.fields[k]}`);
  }
});

Deno.test("rekey estimate trace - logs no paths or hashes (#571)", async () => {
  const since = Date.now();
  await enumerateWork(traceListing(listingClient(5)));
  const text = JSON.stringify(estimateLog(since));
  assert(!/p[0-9]|chunk-|t1/.test(text.replace(/"msg":"[^"]*"/g, "")), text);
});
