import { assertEquals } from "@std/assert";
import { ServerVersion } from "../../../core/protocol.ts";
import { coalesceReplay } from "../../../plugin/sync/replay-coalesce.ts";

function v(seq: number, pathHash: string, version: number, deleted = false): ServerVersion {
  return {
    type: "server_version",
    vault_id: "vault",
    seq,
    path_hash: pathHash,
    parent_version: version - 1,
    enc_metadata: "",
    chunk_hashes: [],
    deleted,
    device_id: "other",
    version,
  };
}

/**
 * A catch-up replay replays every missed server_version. We want to collapse
 * consecutive already-missed versions per path_hash and apply only the LAST per
 * path (the only one that survives on disk), while still landing a correct,
 * contiguous last_seen_seq.
 */
Deno.test("replay-coalesce - collapses N versions of one path to a single winner + N-1 superseded", () => {
  const entries = coalesceReplay([
    v(1, "a", 1),
    v(2, "a", 2),
    v(3, "a", 3),
  ]);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].winner.version, 3);
  assertEquals(entries[0].winner.seq, 3);
  assertEquals(entries[0].supersededSeqs, [1, 2]);
});

Deno.test("replay-coalesce - interleaved paths keep per-path last, in first-appearance order", () => {
  const entries = coalesceReplay([
    v(1, "a", 1),
    v(2, "b", 1),
    v(3, "a", 2),
    v(4, "b", 2),
    v(5, "a", 3),
  ]);
  assertEquals(entries.map((e) => e.winner.path_hash), ["a", "b"]);
  assertEquals(entries[0].winner.version, 3);
  assertEquals(entries[0].supersededSeqs, [1, 3]); // a's earlier seqs 1,3
  assertEquals(entries[1].winner.version, 2);
  assertEquals(entries[1].supersededSeqs, [2]); // b's earlier seq 2
});

Deno.test("replay-coalesce - final-row-is-delete yields a delete winner", () => {
  const entries = coalesceReplay([
    v(1, "a", 1),
    v(2, "a", 2),
    v(3, "a", 3, true),
  ]);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].winner.version, 3);
  assertEquals(entries[0].winner.deleted, true);
  assertEquals(entries[0].supersededSeqs, [1, 2]);
});

Deno.test("replay-coalesce - delete-then-recreate yields the recreate winner", () => {
  const entries = coalesceReplay([
    v(1, "a", 1),
    v(2, "a", 2, true), // delete
    v(3, "a", 3), // recreate
  ]);
  assertEquals(entries.length, 1);
  assertEquals(entries[0].winner.version, 3);
  assertEquals(entries[0].winner.deleted, false);
  assertEquals(entries[0].supersededSeqs, [1, 2]);
});

Deno.test("replay-coalesce - order is deterministic", () => {
  const first = coalesceReplay([
    v(1, "b", 1),
    v(2, "a", 1),
    v(3, "b", 2),
  ]);
  const second = coalesceReplay([
    v(1, "b", 1),
    v(2, "a", 1),
    v(3, "b", 2),
  ]);
  assertEquals(first, second);
  assertEquals(first.map((e) => e.winner.path_hash), ["b", "a"]);
});
