import { assertEquals } from "@std/assert";
import { hashPathHex } from "../../../core/hash.ts";
import type { LocalFileRow } from "../../../plugin/plumbing/state.ts";
import { healStaleRows, planStaleRows } from "../../../plugin/sync/stale-rows.ts";

const KEY = new Uint8Array(32).fill(1);
const OLD_KEY = new Uint8Array(32).fill(2);

function row(path: string, opts: { stale?: boolean; deleted?: boolean } = {}): LocalFileRow {
  return {
    path,
    path_hash: hashPathHex(opts.stale ? OLD_KEY : KEY, path),
    size: 1,
    mtime: 1,
    plaintext_hash: "h",
    last_seen_version: 3,
    chunk_hashes: [],
    deleted: opts.deleted ?? false,
  };
}

const on = (...paths: string[]) => (path: string) => Promise.resolve(paths.includes(path));
const all = () => true;

Deno.test("stale rows - a row under the current hash is left alone", async () => {
  const plan = await planStaleRows([row("a.md")], KEY, on(), all);
  assertEquals(plan, { corrected: [], restore: [] });
});

Deno.test("stale rows - a file on disk only gets its hash corrected", async () => {
  const plan = await planStaleRows([row("a.md", { stale: true })], KEY, on("a.md"), all);
  assertEquals(plan.restore, []);
  assertEquals(plan.corrected.map((r) => r.path_hash), [hashPathHex(KEY, "a.md")]);
  assertEquals(plan.corrected[0].last_seen_version, 3);
});

Deno.test("stale rows - a closed row only gets its hash corrected", async () => {
  const plan = await planStaleRows([row("a.md", { stale: true, deleted: true })], KEY, on(), all);
  assertEquals(plan.restore, []);
  assertEquals(plan.corrected[0].deleted, true);
});

Deno.test("stale rows - a live row with its file gone is restored, not corrected", async () => {
  const plan = await planStaleRows([row("a.md", { stale: true })], KEY, on(), all);
  assertEquals(plan, { corrected: [], restore: ["a.md"] });
});

Deno.test("stale rows - a missing file this device does not sync only gets its hash corrected", async () => {
  const plan = await planStaleRows([row("a.md", { stale: true })], KEY, on(), () => false);
  assertEquals(plan.restore, []);
  assertEquals(plan.corrected.length, 1);
});

Deno.test("stale rows - a failed restore leaves the row stale and does not throw", async () => {
  const stale = row("a.md", { stale: true });
  const upserted: LocalFileRow[] = [];
  await healStaleRows({
    rows: [stale],
    macKey: KEY,
    exists: on(),
    isSyncable: all,
    upsert: (r) => upserted.push(r),
    restore: () => Promise.reject(new Error("offline")),
  });
  assertEquals(upserted, []);
});
