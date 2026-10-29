import {
  MAX_CHUNK_HASHES,
  MAX_ENC_METADATA_LEN,
  MAX_PATH_CIPHERTEXT_LEN,
  validateCommit,
  validateRekeyBatch,
} from "../../../server/ws-commit.ts";
import { type ClientCommit, RENAME_MARKER, RENAME_NOTE } from "../../../core/protocol.ts";
import { assertEquals } from "@std/assert";

function baseCommit(): ClientCommit {
  return {
    type: "client_commit",
    vault_id: "vault",
    path_hash: "a".repeat(64),
    parent_version: 0,
    enc_metadata: "aGk=",
    chunk_hashes: ["b".repeat(64)],
    deleted: false,
  };
}

Deno.test("validateCommit - accepts a well-formed commit", () => {
  assertEquals(validateCommit(baseCommit()), null);
});

Deno.test("validateCommit - rejects a non-64-hex path_hash", () => {
  const bad = baseCommit();
  bad.path_hash = "not-a-hash";
  assertEquals(validateCommit(bad) === null, false);
});

Deno.test("validateCommit - rejects a non-64-hex chunk hash", () => {
  const bad = baseCommit();
  bad.chunk_hashes = ["xyz"];
  assertEquals(validateCommit(bad) === null, false);
});

Deno.test("validateCommit - rejects chunk_hashes that is not an array", () => {
  const bad = baseCommit();
  (bad as { chunk_hashes: unknown }).chunk_hashes = "not-an-array";
  assertEquals(validateCommit(bad) === null, false);
});

Deno.test("validateCommit - rejects a non-integer parent_version", () => {
  const bad = baseCommit();
  (bad as { parent_version: unknown }).parent_version = "1";
  assertEquals(validateCommit(bad) === null, false);
  (bad as { parent_version: unknown }).parent_version = 1.5;
  assertEquals(validateCommit(bad) === null, false);
});

Deno.test("validateCommit - rejects a non-boolean deleted", () => {
  const bad = baseCommit();
  (bad as { deleted: unknown }).deleted = 1;
  assertEquals(validateCommit(bad) === null, false);
});

Deno.test("validateCommit - rejects chunk_hashes over the cap", () => {
  const bad = baseCommit();
  bad.chunk_hashes = Array.from({ length: MAX_CHUNK_HASHES + 1 }, () => "b".repeat(64));
  assertEquals(validateCommit(bad), "too many chunk_hashes");
});

Deno.test("validateCommit - accepts chunk_hashes at the cap", () => {
  const ok = baseCommit();
  ok.chunk_hashes = Array.from({ length: MAX_CHUNK_HASHES }, () => "b".repeat(64));
  assertEquals(validateCommit(ok), null);
});

Deno.test("validateCommit - accepts a marker (deleted + rename_mark 1)", () => {
  const ok = baseCommit();
  ok.deleted = true;
  ok.rename_mark = RENAME_MARKER;
  assertEquals(validateCommit(ok), null);
});

Deno.test("validateCommit - accepts a note (create + rename_mark 2)", () => {
  const ok = baseCommit();
  ok.rename_mark = RENAME_NOTE;
  assertEquals(validateCommit(ok), null);
});

Deno.test("validateCommit - rejects rename_mark on the wrong side of deleted", () => {
  const markerOnCreate = baseCommit();
  markerOnCreate.rename_mark = RENAME_MARKER;
  assertEquals(validateCommit(markerOnCreate), "rename_mark 1 requires deleted");

  const noteOnDelete = baseCommit();
  noteOnDelete.deleted = true;
  noteOnDelete.rename_mark = RENAME_NOTE;
  assertEquals(validateCommit(noteOnDelete), "rename_mark 2 requires a create");
});

Deno.test("validateCommit - rejects an unknown rename_mark", () => {
  for (const mark of [3, -1, 1.5, "1"]) {
    const bad = baseCommit();
    (bad as { rename_mark: unknown }).rename_mark = mark;
    assertEquals(validateCommit(bad), "invalid rename_mark", `rename_mark ${mark}`);
  }
});

Deno.test("validateCommit - rejects enc_metadata over the cap", () => {
  const bad = baseCommit();
  bad.enc_metadata = "a".repeat(MAX_ENC_METADATA_LEN + 1);
  assertEquals(validateCommit(bad), "enc_metadata too large");
});

Deno.test("validateCommit - rejects path_ciphertext over the cap", () => {
  const bad = baseCommit();
  bad.path_ciphertext = "a".repeat(MAX_PATH_CIPHERTEXT_LEN + 1);
  assertEquals(validateCommit(bad), "path_ciphertext too large");
});

Deno.test("validateCommit - accepts path_ciphertext at the cap", () => {
  const ok = baseCommit();
  ok.path_ciphertext = "a".repeat(MAX_PATH_CIPHERTEXT_LEN);
  assertEquals(validateCommit(ok), null);
});

Deno.test("validateCommit - rejects a non-string path_ciphertext", () => {
  const bad = baseCommit();
  (bad as { path_ciphertext: unknown }).path_ciphertext = 42;
  assertEquals(validateCommit(bad), "path_ciphertext too large");
});

Deno.test("validateRekeyBatch - accepts stored rows with both fields at the caps", () => {
  assertEquals(
    validateRekeyBatch([{
      row: {
        enc_metadata: "a".repeat(MAX_ENC_METADATA_LEN),
        path_ciphertext: "b".repeat(MAX_PATH_CIPHERTEXT_LEN),
        chunk_hashes: JSON.stringify(["b".repeat(64)]),
      },
    }], []),
    null,
  );
});

Deno.test("validateRekeyBatch - rejects an enc_metadata over the cap", () => {
  assertEquals(
    validateRekeyBatch([{
      row: {
        enc_metadata: "a".repeat(MAX_ENC_METADATA_LEN + 4),
        path_ciphertext: null,
        chunk_hashes: JSON.stringify(["b".repeat(64)]),
      },
    }], []),
    "enc_metadata too large",
  );
});

Deno.test("validateRekeyBatch - rejects a path_ciphertext over the cap", () => {
  assertEquals(
    validateRekeyBatch([{
      row: {
        enc_metadata: "aGk=",
        path_ciphertext: "b".repeat(MAX_PATH_CIPHERTEXT_LEN + 4),
        chunk_hashes: JSON.stringify(["b".repeat(64)]),
      },
    }], []),
    "path_ciphertext too large",
  );
});

Deno.test("validateRekeyBatch - rejects a trash row whose saved head is oversized", () => {
  assertEquals(
    validateRekeyBatch([], [{
      row: {
        head_json: JSON.stringify({
          enc_metadata: "a".repeat(MAX_ENC_METADATA_LEN + 4),
          path_ciphertext: null,
          chunk_hashes: ["b".repeat(64)],
        }),
      },
    }]),
    "enc_metadata too large",
  );
});

// #680 N-9: a rows batch re-posts stored payloads. `/heads`, blob GC and compaction
// JSON.parse the stored chunk_hashes, so one unparseable value would wedge them.
Deno.test("validateRekeyBatch - rejects a version row whose chunk_hashes is not a JSON array", () => {
  assertEquals(
    validateRekeyBatch([{
      row: { enc_metadata: "aGk=", path_ciphertext: null, chunk_hashes: "not json" },
    }], []),
    "invalid chunk_hashes",
  );
});

Deno.test("validateRekeyBatch - rejects a version row with a malformed or oversized hash list", () => {
  const batch = (chunkHashes: string) => [{
    row: { enc_metadata: "aGk=", path_ciphertext: null, chunk_hashes: chunkHashes },
  }];
  assertEquals(validateRekeyBatch(batch(JSON.stringify(["xyz"])), []), "invalid chunk_hashes");
  assertEquals(validateRekeyBatch(batch(JSON.stringify([])), []), null);
  assertEquals(
    validateRekeyBatch(
      batch(JSON.stringify(Array.from({ length: MAX_CHUNK_HASHES + 1 }, () => "b".repeat(64)))),
      [],
    ),
    "invalid chunk_hashes",
  );
});

Deno.test("validateRekeyBatch - rejects a trash row whose saved head has a malformed hash list", () => {
  assertEquals(
    validateRekeyBatch([], [{
      row: {
        head_json: JSON.stringify({
          enc_metadata: "aGk=",
          path_ciphertext: null,
          chunk_hashes: ["xyz"],
        }),
      },
    }]),
    "invalid chunk_hashes",
  );
});

Deno.test("validateRekeyBatch - rejects an item without a row", () => {
  assertEquals(validateRekeyBatch([{ old_path_hash: "x" }], []), "invalid row");
  assertEquals(validateRekeyBatch([], [null]), "invalid row");
  assertEquals(validateRekeyBatch([], [{ row: { head_json: "not json" } }]), "invalid row");
});

Deno.test("validateRekeyBatch - rejects a batch that is not two arrays", () => {
  assertEquals(validateRekeyBatch(null, []), "versions and trash must be arrays");
  assertEquals(validateRekeyBatch([], "nope"), "versions and trash must be arrays");
});
