import {
  buildConflictRows,
  conflictFileIsMine,
  type ConflictRow,
  type ConflictRowsDeps,
  conflictType,
  countConflictFiles,
  filterConflictRows,
  formatSize,
  keptConflictPath,
  typeLabel,
} from "../../../plugin/sync/conflict-list.ts";
import { assertEquals } from "@std/assert";
import type { StateDB } from "../../../plugin/plumbing/state.ts";
import type { Transport } from "../../../plugin/sync/transport.ts";

// #432: the conflicts list model is obsidian-free: original-path recovery,
// type detection, kept-copy naming, path search, and the mine/theirs split.

Deno.test("conflictType detects note, image, pdf and other from the extension", () => {
  assertEquals(conflictType("Notes/Meeting notes.md"), "note");
  assertEquals(conflictType("photo.jpg"), "image");
  assertEquals(conflictType("deep/dir/pic.PNG"), "image");
  assertEquals(conflictType("scan.pdf"), "pdf");
  assertEquals(conflictType("data.txt"), "other");
  assertEquals(conflictType("noext"), "other");
});

Deno.test("typeLabel renders the compact uppercase tag", () => {
  assertEquals(typeLabel("note"), "NOTE");
  assertEquals(typeLabel("image"), "IMAGE");
  assertEquals(typeLabel("pdf"), "PDF");
  assertEquals(typeLabel("other"), "FILE");
});

Deno.test("keptConflictPath renames beside the original with a kept conflict suffix", () => {
  assertEquals(
    keptConflictPath("Notes/Meeting notes.md"),
    "Notes/Meeting notes (kept conflict).md",
  );
  assertEquals(keptConflictPath("photo.jpg"), "photo (kept conflict).jpg");
  assertEquals(keptConflictPath("data"), "data (kept conflict)");
});

Deno.test("conflictFileIsMine: the embedded device name is authoritative", () => {
  const path = "Notes/a (conflict Laptop B 2026-10-12 1402).md";
  // Matches this device's name → mine.
  assertEquals(conflictFileIsMine(path, "Laptop B", null, "id-A"), true);
  // A different device's name → theirs.
  assertEquals(conflictFileIsMine(path, "Laptop A", null, "id-A"), false);
  // A conflict created by a nameless device embeds the neutral label; a
  // nameless device sees it as its own.
  const neutral = "Notes/a (conflict This device 2026-10-12 1402).md";
  assertEquals(conflictFileIsMine(neutral, "", null, "id-A"), true);
  assertEquals(conflictFileIsMine(neutral, "Laptop A", null, "id-A"), false);
});

Deno.test("conflictFileIsMine: a device name that sanitizes to empty is its own conflict (shared label)", () => {
  const neutral = "Notes/a (conflict This device 2026-10-12 140205).md";
  // "///" sanitizes to "" but the shared label embeds "This device", so the
  // creating device (also "///") recognizes it as mine and Keep mine/theirs
  // do not invert.
  assertEquals(conflictFileIsMine(neutral, "///", null, "id-A"), true);
  assertEquals(conflictFileIsMine(neutral, "Laptop A", null, "id-A"), false);
});

Deno.test("countConflictFiles counts open conflict files across every form, on any device", () => {
  const files = [
    { path: "a (conflict Laptop 2026-10-12 140205).md" },
    { path: "b (conflict Phone 2026-10-12 1402).md" },
    { path: "c (conflict Tablet 2026-10-12 140205 2).md" },
    { path: "d.conflict-2026-10-14T14-05-00.md" },
    { path: "notes.md" },
    { path: "notes (conflict Laptop).md" },
  ];
  assertEquals(countConflictFiles(files), 4);
  assertEquals(countConflictFiles([]), 0);
  assertEquals(countConflictFiles([{ path: "notes.md" }]), 0);
});

Deno.test("conflictFileIsMine: old-format files without a name use the server head's device", () => {
  const oldPath = "Notes/a.conflict-2026-10-14T14-05-00.md";
  assertEquals(conflictFileIsMine(oldPath, "Laptop B", "id-B", "id-B"), true);
  assertEquals(conflictFileIsMine(oldPath, "Laptop A", "id-B", "id-A"), false);
  assertEquals(conflictFileIsMine(oldPath, "Laptop A", null, "id-A"), false);
});

Deno.test("filterConflictRows matches the path case-insensitively; empty query keeps all", () => {
  const rows: ConflictRow[] = [
    {
      path: "Notes/Meeting notes.md",
      conflictPath: "Notes/Meeting notes (conflict Laptop 2026-10-14 1405).md",
      type: "note",
      conflictFileIsMine: true,
      mine: { device: "Laptop", time: 0, size: null },
      theirs: { device: "Phone", time: 0, size: null },
    },
    {
      path: "Attachments/photo.jpg",
      conflictPath: "Attachments/photo (conflict Phone 2026-10-11 1247).jpg",
      type: "image",
      conflictFileIsMine: false,
      mine: { device: "Laptop", time: 0, size: null },
      theirs: { device: "Phone", time: 0, size: null },
    },
  ];
  assertEquals(filterConflictRows(rows, "").length, 2);
  assertEquals(filterConflictRows(rows, "   ").length, 2);
  assertEquals(filterConflictRows(rows, "meeting").map((r) => r.path), ["Notes/Meeting notes.md"]);
  assertEquals(filterConflictRows(rows, "ATTACHMENTS").map((r) => r.path), [
    "Attachments/photo.jpg",
  ]);
  assertEquals(filterConflictRows(rows, "zzz").length, 0);
});

const PATH = "Notes/Plan.md";
const CONFLICT_PATH = "Notes/Plan (conflict Laptop B 2026-10-21 1405).md";

/** A row builder over one conflict pair: the original's server head at version 3
 * (device-a, written 555), the copy's own mtime 2_000. `stat` reports the real
 * byte length of each side, so a CRLF/LF pair really does differ in size;
 * `statFails` makes one side's stat throw, as a hard FS error does. */
function deps(
  over: {
    original?: string;
    conflict?: string;
    deviceName?: string;
    deviceId?: string;
    pair?: { original: string; conflict: string };
    reads?: string[];
    statFails?: "original" | "conflict";
  } = {},
): ConflictRowsDeps {
  const pair = over.pair ?? { original: PATH, conflict: CONFLICT_PATH };
  const failPath = over.statFails ? pair[over.statFails] : null;
  const bytes = (path: string) =>
    new TextEncoder().encode(
      path === pair.original
        ? (over.original ?? "# Plan\nbody")
        : (over.conflict ?? "# Plan\nbody"),
    );
  const localRow = (path: string) => ({
    path,
    path_hash: path === pair.original ? "hash-original" : "hash-conflict",
    size: bytes(path).length,
    mtime: 1_000,
    plaintext_hash: "p",
    last_seen_version: 3,
    chunk_hashes: [],
    deleted: false,
  });
  const statOf = (path: string) => ({
    size: bytes(path).length,
    mtime: path === pair.original ? 1_000 : 2_000,
  });
  return {
    files: () => [{ path: pair.original }, { path: pair.conflict }],
    stat: (path) =>
      path === failPath ? Promise.reject(new Error("stat failed")) : Promise.resolve(statOf(path)),
    read: (path) => {
      over.reads?.push(path);
      return Promise.resolve(bytes(path));
    },
    state: { getLocalFile: (path: string) => localRow(path) } as unknown as StateDB,
    transport: {
      getVersionChain: (pathHash: string) =>
        Promise.resolve([
          {
            version: 3,
            device_id: pathHash === "hash-original" ? "device-a" : "device-b",
            created_at: 555,
          },
        ]),
    } as unknown as Transport,
    deviceName: over.deviceName ?? "Laptop A",
    deviceId: over.deviceId ?? "device-a",
    activity: new Map(),
    deviceNames: new Map([["device-a", "Laptop A"], ["device-b", "Laptop B"]]),
  };
}

Deno.test("buildConflictRows - a CRLF note and its LF copy are the same content despite the byte sizes", async () => {
  // The commit path normalizes line endings before hashing, so these are equal
  // on the server; a stat size gate would hide Remove conflict for the pair.
  const [row] = await buildConflictRows(deps({ conflict: "# Plan\r\nbody" }));
  assertEquals(row.type, "note");
  assertEquals(row.sameContent, true);
});

Deno.test("buildConflictRows - a binary pair is never flagged as the same content and is never read", async () => {
  const reads: string[] = [];
  const [row] = await buildConflictRows(
    deps({
      pair: {
        original: "Attachments/plan.png",
        conflict: "Attachments/plan (conflict Laptop B 2026-07-07 1000).png",
      },
      reads,
    }),
  );
  assertEquals(row.type, "image");
  assertEquals(row.sameContent, false);
  assertEquals(reads, [], "a binary pair is not read to compare it");
});

Deno.test("buildConflictRows - both sides holding the same content is flagged", async () => {
  assertEquals((await buildConflictRows(deps())).map((r) => r.sameContent), [true]);
  assertEquals(
    (await buildConflictRows(deps({ conflict: "# Plan\nother" }))).map((r) => r.sameContent),
    [false],
  );
});

Deno.test("buildConflictRows - the original is labelled with its server head's device and time", async () => {
  // The creating device: the copy holds this device's edit, the original the head.
  const [creating] = await buildConflictRows(
    deps({ deviceName: "Laptop B", deviceId: "device-b" }),
  );
  assertEquals(creating.conflictFileIsMine, true);
  assertEquals(creating.mine.device, "Laptop B");
  // The head version is this device's own write: our display name, not the
  // server's registered one.
  assertEquals(creating.theirs.device, "Laptop A");
  assertEquals(creating.theirs.time, 555);
  // The receiving device: the copy arrived, the original is ours.
  const [receiving] = await buildConflictRows(deps({ deviceName: "Laptop A" }));
  assertEquals(receiving.conflictFileIsMine, false);
  assertEquals(receiving.mine.device, "Laptop A");
  assertEquals(receiving.mine.time, 555);
  assertEquals(receiving.theirs.device, "Laptop B");
});

Deno.test("buildConflictRows - a third device labels the original with the head's device", async () => {
  // Neither side is ours here: the copy came from Laptop B, the original was
  // written by Laptop A. The original's card must name Laptop A, not this device.
  const [row] = await buildConflictRows(
    deps({ deviceName: "Laptop C", deviceId: "device-c" }),
  );
  assertEquals(row.conflictFileIsMine, false);
  assertEquals(row.mine.device, "Laptop A");
  assertEquals(row.mine.time, 555);
  assertEquals(row.theirs.device, "Laptop B");
});

Deno.test("buildConflictRows - the conflict copy is labelled with its own device and mtime", async () => {
  for (const deviceName of ["Laptop A", "Laptop C"]) {
    const [row] = await buildConflictRows(deps({ deviceName }));
    const copy = row.conflictFileIsMine ? row.mine : row.theirs;
    assertEquals(copy.device, "Laptop B");
    // The file's mtime, never the copy's own server version time.
    assertEquals(copy.time, 2_000);
  }
});

Deno.test("buildConflictRows - a stat that throws keeps the row, its size unknown", async () => {
  // A hard FS error is not fatal: the row stays, with no size, and the original
  // still takes the server head's time.
  const [noOriginal] = await buildConflictRows(deps({ statFails: "original" }));
  assertEquals(noOriginal.mine.size, null);
  assertEquals(noOriginal.mine.time, 555);
  const [noConflict] = await buildConflictRows(deps({ statFails: "conflict" }));
  assertEquals(noConflict.theirs.size, null);
  assertEquals(noConflict.theirs.time, null);
});

Deno.test("formatSize renders bytes, KB and MB", () => {
  assertEquals(formatSize(512), "512 B");
  assertEquals(formatSize(2048), "2.0 KB");
  assertEquals(formatSize(5 * 1024 * 1024), "5.0 MB");
});
