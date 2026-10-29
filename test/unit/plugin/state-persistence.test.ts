import { type LocalFileRow, openStateDB } from "../../../plugin/plumbing/state.ts";
import {
  loadPersistedState,
  readLastBackupAt,
  wireStatePersistence,
} from "../../../plugin/plumbing/state-persistence.ts";
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";

const ROW_A: LocalFileRow = {
  path: "notes/test.md",
  path_hash: "abc123",
  size: 42,
  mtime: 1700000000000,
  plaintext_hash: "plain1",
  last_seen_version: 3,
  chunk_hashes: ["chunk1", "chunk2"],
  deleted: false,
};

const ROW_B: LocalFileRow = {
  path: "notes/deleted.md",
  path_hash: "def456",
  size: 10,
  mtime: 1700000100000,
  plaintext_hash: "plain2",
  last_seen_version: 5,
  chunk_hashes: ["chunk3"],
  deleted: true,
};

Deno.test("state-persistence - local_files survive serialize -> reopen", () => {
  const db = openStateDB();
  db.upsertLocalFile(ROW_A);
  db.upsertLocalFile(ROW_B);

  const json = db.serializeLocalFiles();
  db.close();

  const rows: LocalFileRow[] = JSON.parse(json);
  assertEquals(rows.length, 2);

  const db2 = openStateDB(rows);

  const a = db2.getLocalFile("notes/test.md");
  assert(a !== null);
  assertEquals(a!.plaintext_hash, ROW_A.plaintext_hash);
  assertEquals(a!.last_seen_version, ROW_A.last_seen_version);
  assertEquals(a!.deleted, ROW_A.deleted);
  assertEquals(a!.chunk_hashes, ROW_A.chunk_hashes);

  const b = db2.getLocalFile("notes/deleted.md");
  assert(b !== null);
  assertEquals(b!.plaintext_hash, ROW_B.plaintext_hash);
  assertEquals(b!.last_seen_version, ROW_B.last_seen_version);
  assertEquals(b!.deleted, ROW_B.deleted);
  assertEquals(b!.chunk_hashes, ROW_B.chunk_hashes);

  db2.close();
});

Deno.test("state-persistence - throttled persist hook fires at the window edge", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();

    let captured: string | null = null;
    db.setPersist((json: string) => {
      captured = json;
    });

    db.upsertLocalFile({
      path: "hook-test.md",
      path_hash: "ht001",
      size: 1,
      mtime: 0,
      plaintext_hash: "ph001",
      last_seen_version: 1,
      chunk_hashes: ["c1"],
    });

    // Trailing throttle: the first change writes after the 2s window.
    time.tick(1999);
    assertEquals(captured, null, "must not fire before the window elapses");
    time.tick(1);

    assert(captured !== null, "persist hook should have fired at the window");
    const rows = JSON.parse(captured!);
    assert(Array.isArray(rows));
    const found = rows.find((r: LocalFileRow) => r.path === "hook-test.md");
    assert(found !== undefined, "captured rows should contain hook-test.md");
    assertEquals(found.plaintext_hash, "ph001");

    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("state-persistence - close flushes pending persist", () => {
  const db = openStateDB();

  let captured: string | null = null;
  db.setPersist((json: string) => {
    captured = json;
  });

  db.upsertLocalFile({
    path: "flush-test.md",
    path_hash: "ft001",
    size: 2,
    mtime: 0,
    plaintext_hash: "ph002",
    last_seen_version: 1,
    chunk_hashes: ["c2"],
  });

  // Close immediately: should flush synchronously
  db.close();

  assert(captured !== null, "close should flush pending persist");
  const rows = JSON.parse(captured!);
  assert(Array.isArray(rows));
  const found = rows.find((r: LocalFileRow) => r.path === "flush-test.md");
  assert(found !== undefined, "captured rows should contain flush-test.md");
});

// --- loadPersistedState tests ---

const makeRead = (data: Record<string, Uint8Array>) => {
  return (path: string): Promise<Uint8Array> => {
    const entry = data[path];
    if (!entry) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(entry);
  };
};

const encoder = new TextEncoder();

Deno.test("loadPersistedState - both files valid", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([ROW_A, ROW_B])),
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v1", last_seen_seq: 42 })),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted?.length, 2);
  assertEquals(result.persisted?.[0].path, "notes/test.md");
  assertEquals(result.persistedCursor, 42);
});

Deno.test("loadPersistedState - a leftover version-cache.json (old field) is ignored", async () => {
  // Real devices still carry the removed version-cache.json. The loader must
  // never read or trip on it: localFiles + cursor load fine, cache is ignored.
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([ROW_A])),
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v", last_seen_seq: 3 })),
    "version-cache.json": encoder.encode("[{broken"),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted?.length, 1);
  assertEquals(result.persisted?.[0].path, "notes/test.md");
  assertEquals(result.persistedCursor, 3);
});

Deno.test("loadPersistedState - local-files missing → null, cursor fine", async () => {
  const read = makeRead({
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v", last_seen_seq: 7 })),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted, null);
  assertEquals(result.persistedCursor, 7);
});

Deno.test("loadPersistedState - cursor missing → null", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([])),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted?.length, 0);
  assertEquals(result.persistedCursor, null);
});

Deno.test("loadPersistedState - both files corrupt → both null", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode("not json"),
    "sync-cursor.json": encoder.encode("also not json"),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted, null);
  assertEquals(result.persistedCursor, null);
});

Deno.test("loadPersistedState - cursor with non-number last_seen_seq → null", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([])),
    "sync-cursor.json": encoder.encode(
      JSON.stringify({ vault_id: "v", last_seen_seq: "not-a-number" }),
    ),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persisted?.length, 0);
  assertEquals(result.persistedCursor, null);
});

Deno.test("loadPersistedState - cursor with missing last_seen_seq → null", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([])),
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v" })),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.persistedCursor, null);
});

Deno.test("loadPersistedState - parses last_backup_at from the cursor", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([])),
    "sync-cursor.json": encoder.encode(JSON.stringify({
      vault_id: "v",
      last_seen_seq: 9,
      last_backup_at: 1_700_000_000_000,
    })),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.lastBackupAt, 1_700_000_000_000);
});

Deno.test("loadPersistedState - cursor without last_backup_at → 0", async () => {
  const read = makeRead({
    "local-files.json": encoder.encode(JSON.stringify([])),
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v", last_seen_seq: 9 })),
  });

  const result = await loadPersistedState(read, {
    localFiles: "local-files.json",
    cursor: "sync-cursor.json",
  });

  assertEquals(result.lastBackupAt, 0, "old files without the field load as 0");
});

Deno.test("readLastBackupAt - reads the stamp straight from sync-cursor.json", async () => {
  const read = makeRead({
    "sync-cursor.json": encoder.encode(JSON.stringify({
      vault_id: "v",
      last_seen_seq: 3,
      last_backup_at: 1234,
    })),
  });
  assertEquals(await readLastBackupAt(read, "sync-cursor.json"), 1234);
});

Deno.test("readLastBackupAt - missing file / absent field → 0", async () => {
  const read = makeRead({
    "sync-cursor.json": encoder.encode(JSON.stringify({ vault_id: "v", last_seen_seq: 3 })),
  });
  assertEquals(await readLastBackupAt(read, "sync-cursor.json"), 0);
  assertEquals(await readLastBackupAt(read, "nonexistent.json"), 0);
});

// --- wireStatePersistence tests ---

Deno.test("wireStatePersistence - persist callbacks wire to correct paths", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    const calls: { path: string; bytes: Uint8Array }[] = [];
    const write = (path: string, bytes: Uint8Array) => {
      calls.push({ path, bytes });
    };

    wireStatePersistence(db, write, {
      localFiles: "data/local-files.json",
      cursor: "data/sync-cursor.json",
    });

    db.upsertLocalFile({
      path: "test.md",
      path_hash: "ph1",
      size: 10,
      mtime: 0,
      plaintext_hash: "p1",
      last_seen_version: 1,
      chunk_hashes: [],
    });
    time.tick(2000); // local-files throttle fires

    db.updateSyncCursor(99); // cursor persists immediately: not throttled

    assertEquals(calls.length, 2);
    assertEquals(calls[0].path, "data/local-files.json");
    const localRows = JSON.parse(new TextDecoder().decode(calls[0].bytes));
    assert(Array.isArray(localRows));
    assertEquals(localRows[0].path, "test.md");

    assertEquals(calls[1].path, "data/sync-cursor.json");
    const cursorData = JSON.parse(new TextDecoder().decode(calls[1].bytes));
    assertEquals(cursorData.last_seen_seq, 99);

    db.close();
  } finally {
    time.restore();
  }
});

Deno.test("wireStatePersistence - json round-trips correctly", () => {
  const time = new FakeTime();
  try {
    const db = openStateDB();
    let capturedJson = "";
    const write = (_path: string, bytes: Uint8Array) => {
      capturedJson = new TextDecoder().decode(bytes);
    };

    wireStatePersistence(db, write, {
      localFiles: "f.json",
      cursor: "c.json",
    });

    db.upsertLocalFile({
      path: "round.md",
      path_hash: "rh1",
      size: 5,
      mtime: 123,
      plaintext_hash: "pr",
      last_seen_version: 2,
      chunk_hashes: ["a", "b"],
      deleted: true,
    });
    time.tick(2000); // local-files throttle fires

    const rows: LocalFileRow[] = JSON.parse(capturedJson);
    assertEquals(rows[0].path, "round.md");
    assertEquals(rows[0].deleted, true);
    assertEquals(rows[0].chunk_hashes, ["a", "b"]);

    db.close();
  } finally {
    time.restore();
  }
});
