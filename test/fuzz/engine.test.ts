import {
  checkRenameHistoryLinks,
  checkRenameNoEditLost,
  checkRenameNoResurrected,
  type DeviceView,
  FuzzError,
  matchKnownFailure,
  RenameBook,
  type RenameRecord,
  runConcurrentBinarySequence,
  runConcurrentSequence,
  runRenameSequence,
  runSequence,
  runTripleSequence,
} from "./engine.ts";
import { hashPathHex } from "../../core/hash.ts";
import { deriveKeys, encryptMetadata, type VaultKeys } from "../../core/crypto.ts";
import type { FileMeta } from "../../core/protocol.ts";
import { insertVersion, openDb } from "../../server/db.ts";
import { makeTempDataDir, removeTempDir } from "../helpers/temp-dir.ts";
import { assertRejects, assertThrows } from "@std/assert";

// These fuzz specs are integration tests that manage a real server lifecycle
// (Deno.serve + WebSocket upgrade), which creates resources we don't control.
const SANITIZE_OPTS = { sanitizeResources: false };

/** A seed's test: a known-failure match is quarantined (logged), anything else rethrows. */
function fuzzTest(name: string, run: () => Promise<void>): void {
  Deno.test({
    name,
    ...SANITIZE_OPTS,
    async fn() {
      try {
        await run();
      } catch (e) {
        const known = e instanceof FuzzError ? matchKnownFailure(e) : null;
        if (known) {
          console.log(
            `QUARANTINED [${name}]: ${(e as FuzzError).invariant} (${
              (e as FuzzError).message.split("\n")[0]
            }) (issue: ${known.issue})`,
          );
          return;
        }
        throw e;
      }
    },
  });
}

const seeds = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

// ── Sequence ───────────────────────────────────────────────────────────

for (const seed of seeds(5)) {
  fuzzTest(`fuzz seq seed=${seed}`, () => runSequence({ seed, turns: 8, opsPerTurn: 5 }));
}

// ── Concurrent ─────────────────────────────────────────────────────────

for (const seed of seeds(5)) {
  fuzzTest(`fuzz concurrent seed=${seed}`, () => runConcurrentSequence({ seed, turns: 6 }));
}

// ── Concurrent Binary ──────────────────────────────────────────────────

for (const seed of seeds(5)) {
  fuzzTest(`fuzz binary seed=${seed}`, () => runConcurrentBinarySequence({ seed, turns: 4 }));
}

// ── Triple (3-device) ──────────────────────────────────────────────────

for (const seed of seeds(3)) {
  fuzzTest(`fuzz triple seed=${seed}`, () => runTripleSequence({ seed, turns: 4 }));
}

// ── Rename (concurrent, #587) ──────────────────────────────────────────

for (const seed of seeds(3)) {
  fuzzTest(`fuzz rename seed=${seed}`, () => runRenameSequence({ seed, turns: 4 }));
}

fuzzTest("fuzz rename triple seed=1", () => runRenameSequence({ seed: 1, turns: 3, devices: 3 }));

// #590: a rename onto a name the peer created in the same turn lost the creator's
// edit (`conflict resolved as no-op`). Seed 51 reproduces it (2 devices, turn 3).
fuzzTest(
  "fuzz rename seed=51 (create vs rename, #590)",
  () => runRenameSequence({ seed: 51, turns: 4 }),
);

// #600: a live rename onto a name the peer's create already took closed the old name
// as a plain delete (a trash entry, restorable; the link lost) instead of a marker.
for (const seed of [68, 179, 394]) {
  fuzzTest(
    `fuzz rename seed=${seed} (destination taken, #600)`,
    () => runRenameSequence({ seed, turns: 4, historyLinks: true }),
  );
}

// #615: a rename chain of one device (X → Y → Z) writes nothing at the middle name, so
// the oracle folds it; these two seeds flagged the missing link before the collapse.
for (const seed of [217, 764]) {
  fuzzTest(
    `fuzz rename seed=${seed} (chain link, #615)`,
    () => runRenameSequence({ seed, turns: 4, historyLinks: true }),
  );
}

// #611: two devices rewrote the SAME word on one line (base `RN0-1`, local
// `RN1-17`, remote `RN0-21`); the per-hunk char fallback spliced the two edits
// into `RN1-217` and kept neither. 3 devices, rename links oracle on.
fuzzTest(
  "fuzz rename triple seed=201 (same-word splice, #611)",
  () => runRenameSequence({ seed: 201, turns: 4, devices: 3, historyLinks: true }),
);

// ── Rename oracles ─────────────────────────────────────────────────────

function view(label: string, files: Record<string, string>): DeviceView {
  const enc = new TextEncoder();
  return {
    label,
    files: new Map(Object.entries(files).map(([p, t]) => [p, enc.encode(t)])),
  };
}

Deno.test("rename oracle: a lost edit fails the no-loss invariant", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  const views = [view("A", { "b.md": "kept" }), view("B", { "b.md": "kept" })];
  assertThrows(() => checkRenameNoEditLost(views, book, 1, []), FuzzError, "RN7");
});

Deno.test("rename oracle: a token may survive only in a conflict file", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  const views = [
    view("A", { "a (conflict 1).md": "RN7" }),
    view("B", { "a (conflict 1).md": "RN7" }),
  ];
  checkRenameNoEditLost(views, book, 1, []);
});

Deno.test("rename oracle: a token must survive on EVERY device", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  const views = [view("A", { "a.md": "RN7" }), view("B", { "b.md": "kept" })];
  assertThrows(() => checkRenameNoEditLost(views, book, 1, []), FuzzError, "missing on B");
});

Deno.test("rename oracle: a delete after the edit exempts its content", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  book.addDelete("a.md", 9);
  checkRenameNoEditLost([view("A", {}), view("B", {})], book, 1, []);
});

Deno.test("rename oracle: a delete BEFORE the edit does not exempt it", () => {
  const book = new RenameBook();
  book.addDelete("a.md", 3);
  book.addEdit(0, "RN7", 7, "a.md");
  assertThrows(
    () => checkRenameNoEditLost([view("A", {}), view("B", {})], book, 1, []),
    FuzzError,
    "RN7",
  );
});

Deno.test("rename oracle: the same device overwriting its own edit exempts it", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  book.addEdit(0, "RN8", 8, "a.md");
  checkRenameNoEditLost([view("A", { "a.md": "RN8" }), view("B", { "a.md": "RN8" })], book, 1, []);
});

Deno.test("rename oracle: another device overwriting an edit is a race, not an exemption", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  book.addEdit(1, "RN8", 8, "a.md");
  const views = [view("A", { "a.md": "RN8" }), view("B", { "a.md": "RN8" })];
  assertThrows(() => checkRenameNoEditLost(views, book, 1, []), FuzzError, "RN7");
});

Deno.test("rename oracle: a rename carries the tracked content to its new name", () => {
  const book = new RenameBook();
  book.addEdit(0, "RN7", 7, "a.md");
  book.addRename("a.md", "b.md", 8, 0, 0);
  book.addDelete("b.md", 9);
  checkRenameNoEditLost([view("A", {}), view("B", {})], book, 1, []);
});

Deno.test("rename oracle: an edit on a renamed-away name is still a resurrection", () => {
  const book = new RenameBook();
  book.addRename("a.md", "b.md", 8, 0, 0);
  book.addEdit(1, "RN9", 9, "a.md");
  const views = [
    view("A", { "a.md": "RN9", "b.md": "x" }),
    view("B", { "a.md": "RN9", "b.md": "x" }),
  ];
  assertThrows(() => checkRenameNoResurrected(views, book, [], 1, []), FuzzError, "a.md");
});

Deno.test("rename oracle: a renamed-away name that comes back fails", () => {
  const book = new RenameBook();
  book.addRename("a.md", "b.md", 8, 0, 0);
  const views = [view("A", { "a.md": "x" }), view("B", { "b.md": "x" })];
  assertThrows(
    () => checkRenameNoResurrected(views, book, [], 1, []),
    FuzzError,
    "renamed away at op 8",
  );
});

Deno.test("rename oracle: a create may legitimately reuse a renamed-away name", () => {
  const book = new RenameBook();
  book.addRename("a.md", "b.md", 8, 0, 0);
  book.addCreate("a.md");
  const views = [
    view("A", { "a.md": "new", "b.md": "x" }),
    view("B", { "a.md": "new", "b.md": "x" }),
  ];
  checkRenameNoResurrected(views, book, [], 1, []);
});

// #587 (seed 77): B renames `new-0-8.md -> n0.md` offline while C renames
// `n0.md -> dir-a/n0.md` in the same turn. Both files exist, nothing is lost, and
// `n0.md` legitimately holds B's content: a concurrent rename-into re-creates the
// name exactly like a create does.
Deno.test("rename oracle: a concurrent rename-into may reuse a renamed-away name", () => {
  const book = new RenameBook();
  book.addCreate("n0.md");
  book.addRename("new-0-8.md", "n0.md", 8, 1, 1);
  book.addRename("n0.md", "dir-a/n0.md", 10, 2, 1);
  const renames: RenameRecord[] = [
    { from: "new-0-8.md", to: "n0.md", order: 8, dev: 1, turn: 1 },
    { from: "n0.md", to: "dir-a/n0.md", order: 10, dev: 2, turn: 1 },
  ];
  const files = { "n0.md": "RN1-8", "dir-a/n0.md": "RN0-1" };
  const views = [view("A", files), view("B", files), view("C", files)];
  checkRenameNoResurrected(views, book, renames, 77, []);
});

Deno.test("rename oracle: a later rename-into may reuse a renamed-away name", () => {
  const book = new RenameBook();
  book.addCreate("n0.md");
  book.addRename("n0.md", "dir-a/n0.md", 5, 0, 1);
  book.addRename("dir-b/n3.md", "n0.md", 20, 1, 3);
  const renames: RenameRecord[] = [
    { from: "n0.md", to: "dir-a/n0.md", order: 5, dev: 0, turn: 1 },
    { from: "dir-b/n3.md", to: "n0.md", order: 20, dev: 1, turn: 3 },
  ];
  const files = { "n0.md": "RN1-20", "dir-a/n0.md": "RN0-1" };
  checkRenameNoResurrected([view("A", files), view("B", files)], book, renames, 587, []);
});

Deno.test("rename oracle: nothing re-occupying the name is still a resurrection", () => {
  const book = new RenameBook();
  book.addCreate("n0.md");
  book.addRename("n0.md", "dir-a/n0.md", 12, 0, 2);
  const renames: RenameRecord[] = [
    { from: "n0.md", to: "dir-a/n0.md", order: 12, dev: 0, turn: 2 },
  ];
  const files = { "n0.md": "RN0-1", "dir-a/n0.md": "RN0-1" };
  const views = [view("A", files), view("B", files)];
  assertThrows(
    () => checkRenameNoResurrected(views, book, renames, 587, []),
    FuzzError,
    "renamed away at op 12",
  );
});

Deno.test("rename oracle: a rename-into BEFORE the rename-away does not excuse it", () => {
  const book = new RenameBook();
  book.addCreate("n0.md");
  book.addRename("dir-b/n3.md", "n0.md", 4, 1, 0);
  book.addRename("n0.md", "dir-a/n0.md", 9, 0, 2);
  const renames: RenameRecord[] = [
    { from: "dir-b/n3.md", to: "n0.md", order: 4, dev: 1, turn: 0 },
    { from: "n0.md", to: "dir-a/n0.md", order: 9, dev: 0, turn: 2 },
  ];
  const files = { "n0.md": "RN0-1", "dir-a/n0.md": "RN0-1" };
  const views = [view("A", files), view("B", files)];
  assertThrows(
    () => checkRenameNoResurrected(views, book, renames, 587, []),
    FuzzError,
    "renamed away at op 9",
  );
});

// Oracle 4 against a real SQLite store: a plain delete+create pair carries no
// link, and this rename's own marker (old name) + note (new name) passes. The link
// is read from the encrypted metadata, so a pooled name reused by a later
// generation cannot satisfy it.
const ORACLE_KEYS = await deriveKeys("fuzz-oracle", new Uint8Array(16), {
  opsLimit: 1,
  memLimit: 8192,
});

function withRenameDb(
  fn: (db: ReturnType<typeof openDb>, keys: VaultKeys) => Promise<void> | void,
): Promise<void> {
  const dir = makeTempDataDir();
  const db = openDb(dir);
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    "v",
    "t",
    new Uint8Array(16),
    0,
  );
  db.run("INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)", "d", "v", "d", "t");
  return Promise.resolve(fn(db, ORACLE_KEYS)).finally(() => {
    db.close();
    removeTempDir(dir);
  });
}

async function versionRow(
  db: ReturnType<typeof openDb>,
  keys: VaultKeys,
  path: string,
  parent: number,
  deleted: boolean,
  renameMark: number,
  link?: Partial<FileMeta>,
): Promise<void> {
  const pathHash = hashPathHex(keys.mac_key, path);
  const meta: FileMeta = {
    path,
    mtime: 0,
    size: 0,
    mime: "text/markdown",
    plaintext_hash: "",
    ...link,
  };
  const enc = await encryptMetadata(meta, keys, pathHash);
  insertVersion(db, "v", pathHash, parent, enc, [], deleted, "d", null, renameMark);
}

Deno.test("rename links oracle: a plain delete+create pair has no marker/note", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, true, 0);
    await versionRow(db, keys, "b.md", 0, false, 0);
    await assertRejects(
      () =>
        checkRenameHistoryLinks(
          db,
          "v",
          keys,
          [{ from: "a.md", to: "b.md", order: 1, dev: 0, turn: 0 }],
          1,
          [],
        ),
      FuzzError,
      "no marker for this rename",
    );
  });
});

Deno.test("rename links oracle: this rename's own marker + note passes", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, true, 1, { renamed_to: "b.md" });
    await versionRow(db, keys, "b.md", 0, false, 2, { renamed_from: "a.md" });
    await versionRow(db, keys, "b.md", 1, false, 0);
    await checkRenameHistoryLinks(
      db,
      "v",
      keys,
      [{ from: "a.md", to: "b.md", order: 1, dev: 0, turn: 0 }],
      1,
      [],
    );
  });
});

Deno.test("rename links oracle: a note must point at this rename's marker", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, false, 0);
    await versionRow(db, keys, "a.md", 2, true, 1, { renamed_to: "b.md" }); // marker: v3
    // The note caps at v2: an earlier generation, not this rename's marker (v3).
    await versionRow(db, keys, "b.md", 0, false, 2, {
      renamed_from: "a.md",
      renamed_from_version: 2,
    });
    await assertRejects(
      () =>
        checkRenameHistoryLinks(
          db,
          "v",
          keys,
          [{ from: "a.md", to: "b.md", order: 1, dev: 0, turn: 0 }],
          1,
          [],
        ),
      FuzzError,
      "no note for this rename",
    );
  });
});

Deno.test("rename links oracle: a note capped at this rename's marker passes", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, false, 0);
    await versionRow(db, keys, "a.md", 2, true, 1, { renamed_to: "b.md" }); // marker: v3
    await versionRow(db, keys, "b.md", 0, false, 2, {
      renamed_from: "a.md",
      renamed_from_version: 3,
    });
    await checkRenameHistoryLinks(
      db,
      "v",
      keys,
      [{ from: "a.md", to: "b.md", order: 1, dev: 0, turn: 0 }],
      1,
      [],
    );
  });
});

Deno.test("rename links oracle: a pooled name's other-generation link does not count", async () => {
  await withRenameDb(async (db, keys) => {
    // a.md was renamed to z.md earlier; b.md was opened by a rename from q.md.
    await versionRow(db, keys, "a.md", 0, false, 1, { renamed_to: "z.md" });
    await versionRow(db, keys, "b.md", 0, false, 2, { renamed_from: "q.md" });
    await assertRejects(
      () =>
        checkRenameHistoryLinks(
          db,
          "v",
          keys,
          [{ from: "a.md", to: "b.md", order: 2, dev: 0, turn: 0 }],
          1,
          [],
        ),
      FuzzError,
      "no marker for this rename",
    );
  });
});

Deno.test("rename links oracle: a silent rename is not excused by its own trace record", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, true, 0);
    await versionRow(db, keys, "b.md", 0, false, 0);
    await assertRejects(
      () =>
        checkRenameHistoryLinks(
          db,
          "v",
          keys,
          [
            { from: "a.md", to: "b.md", order: 2, turn: 0, silent: true },
          ],
          1,
          [
            {
              kind: "rn-rename",
              dev: 0,
              turn: 0,
              order: 2,
              from: "a.md",
              to: "b.md",
              silent: true,
            },
          ],
        ),
      FuzzError,
      "no marker for this rename",
    );
  });
});

Deno.test("rename links oracle: a silent rename yields to a destination written first", async () => {
  await withRenameDb(async (db, keys) => {
    await versionRow(db, keys, "a.md", 0, false, 0);
    await versionRow(db, keys, "a.md", 1, true, 0);
    await versionRow(db, keys, "b.md", 0, false, 0);
    await checkRenameHistoryLinks(
      db,
      "v",
      keys,
      [
        { from: "a.md", to: "b.md", order: 3, turn: 0, silent: true },
      ],
      1,
      [
        { kind: "rn-create", dev: 1, turn: 0, order: 1, path: "b.md", token: "T" },
        { kind: "rn-rename", dev: 0, turn: 0, order: 3, from: "a.md", to: "b.md", silent: true },
      ],
    );
  });
});
