import { assertEquals } from "@std/assert";
import {
  binaryPreviewLine,
  deletedFromLabel,
  deviceNameLabel,
  fileTypeLabel,
  formatBytes,
  keptLabel,
  plural,
  previewFetches,
  previewKind,
  purgeNeedsAdmin,
  relativeTime,
  retention,
  retentionLabel,
  shortPathHash,
  trashCountLabel,
  trashEntryLabel,
} from "../../../plugin/ui/trash-format.ts";

// #446/#455: row text, retention math, expiry, device name, size + preview kind.
const DAY = 86400;
const NOW = 1_800_000_000;

Deno.test("trashEntryLabel - uses decrypted path when present", () => {
  assertEquals(
    trashEntryLabel({ path: "notes/todo.md", path_hash: "abcdef0123456789" }),
    "notes/todo.md",
  );
});

Deno.test("trashEntryLabel - falls back to short hash when path absent", () => {
  const hash = "0123456789abcdef0123456789abcdef";
  assertEquals(trashEntryLabel({ path_hash: hash }), shortPathHash(hash));
});

Deno.test("shortPathHash - head…tail form", () => {
  assertEquals(shortPathHash("0123456789abcdef0123456789abcdef"), "01234567…cdef");
});

Deno.test("relativeTime - buckets", () => {
  const now = Math.floor(Date.now() / 1000);
  assertEquals(relativeTime(now), "just now");
  assertEquals(relativeTime(now - 120), "2 minutes ago");
  assertEquals(relativeTime(now - 7200), "2 hours ago");
  assertEquals(relativeTime(now - 172800), "2 days ago");
});

Deno.test("trashCountLabel - loading/error/empty/count (settings Deleted-files row)", () => {
  assertEquals(trashCountLabel({ status: "loading" }), "Checking trash…");
  assertEquals(trashCountLabel({ status: "error" }), "Couldn't check the trash");
  assertEquals(trashCountLabel({ status: "loaded", count: 0 }), "Trash is empty");
  assertEquals(trashCountLabel({ status: "loaded", count: 1 }), "1 file in trash");
  assertEquals(trashCountLabel({ status: "loaded", count: 3 }), "3 files in trash");
});

Deno.test("deletedFromLabel - Deleted <relative> from <device>", () => {
  assertEquals(deletedFromLabel(NOW - 2 * DAY, "Phone", NOW), "Deleted 2 days ago from Phone");
  assertEquals(deletedFromLabel(NOW - 3600, "Laptop", NOW), "Deleted 1 hours ago from Laptop");
});

Deno.test("retention - days left and expiry boundary (strict, matches server purge)", () => {
  assertEquals(retention(NOW - 2 * DAY, 30, NOW), { daysLeft: 28, expired: false });
  assertEquals(retention(NOW - 29 * DAY, 30, NOW), { daysLeft: 1, expired: false });
  // 29.9 days elapsed still rounds up to 1 day left (never "0 days").
  assertEquals(retention(NOW - 29.9 * DAY, 30, NOW), { daysLeft: 1, expired: false });
  // Exact boundary (trashed_at === cutoff): the server purges strictly `trashed_at <
  // cutoff`, so this is NOT yet expired and reads "purges in 1 day".
  assertEquals(retention(NOW - 30 * DAY, 30, NOW), { daysLeft: 1, expired: false });
  // One second past the boundary: expired.
  assertEquals(retention(NOW - 30 * DAY - 1, 30, NOW), { daysLeft: 0, expired: true });
  assertEquals(retention(NOW - 40 * DAY, 30, NOW), { daysLeft: 0, expired: true });
});

Deno.test("retentionLabel - purges in N days (singular) or expired", () => {
  assertEquals(retentionLabel(NOW - 2 * DAY, 30, NOW), "purges in 28 days");
  assertEquals(retentionLabel(NOW - 29 * DAY, 30, NOW), "purges in 1 day");
  assertEquals(retentionLabel(NOW - 30 * DAY, 30, NOW), "purges in 1 day");
  assertEquals(retentionLabel(NOW - 30 * DAY - 1, 30, NOW), "expired");
});

Deno.test("plural - singular for 1, plural otherwise", () => {
  assertEquals(plural(1, "file"), "file");
  assertEquals(plural(2, "file"), "files");
  assertEquals(plural(0, "file"), "files");
});

Deno.test("previewFetches - binary never fetches, text/image capped by size", () => {
  // Binary: never fetch, whatever the size.
  assertEquals(previewFetches("binary", 100), false);
  assertEquals(previewFetches("binary", 1024 * 1024 * 200), false);
  assertEquals(previewFetches("binary", undefined), false);
  // Text cap: 5 MB inclusive.
  assertEquals(previewFetches("text", 1024), true);
  assertEquals(previewFetches("text", 5 * 1024 * 1024), true);
  assertEquals(previewFetches("text", 5 * 1024 * 1024 + 1), false);
  // Image cap: 20 MB inclusive.
  assertEquals(previewFetches("image", 5 * 1024 * 1024), true);
  assertEquals(previewFetches("image", 20 * 1024 * 1024), true);
  assertEquals(previewFetches("image", 20 * 1024 * 1024 + 1), false);
  // No size metadata (locked list): fall back to fetching.
  assertEquals(previewFetches("text", undefined), true);
  assertEquals(previewFetches("image", undefined), true);
});

Deno.test("deviceNameLabel - maps device id, falls back to Another device", () => {
  const names = new Map([["dev-1", "Phone"]]);
  assertEquals(deviceNameLabel("dev-1", names), "Phone");
  assertEquals(deviceNameLabel("dev-9", names), "Another device");
  assertEquals(deviceNameLabel("dev-1", null), "Another device");
  assertEquals(deviceNameLabel("dev-1", undefined), "Another device");
  // Blank stored name falls back too.
  assertEquals(deviceNameLabel("dev-x", new Map([["dev-x", "  "]])), "Another device");
});

Deno.test("keptLabel - retention toolbar text", () => {
  assertEquals(keptLabel(30), "Kept 30 days");
  assertEquals(keptLabel(1), "Kept 1 day");
});

Deno.test("formatBytes - B, KB, MB, GB with clean decimals", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(245760), "240 KB");
  assertEquals(formatBytes(1572864), "1.5 MB");
  assertEquals(formatBytes(1073741824), "1 GB");
});

Deno.test("previewKind - text/image/binary by mime", () => {
  assertEquals(previewKind("note.md", "text/markdown"), "text");
  assertEquals(previewKind("note.txt", "text/plain"), "text");
  assertEquals(previewKind("pic.png", "image/png"), "image");
  assertEquals(previewKind("scan.pdf", "application/pdf"), "binary");
});

Deno.test("fileTypeLabel - uppercase extension, mime fallback, File for octet-stream", () => {
  assertEquals(fileTypeLabel("scan.pdf", "application/pdf"), "PDF");
  assertEquals(fileTypeLabel("archive.tar.gz", "application/gzip"), "GZ");
  assertEquals(fileTypeLabel("README", "application/octet-stream"), "File");
  assertEquals(fileTypeLabel("noext", "application/vnd.custom"), "VND.CUSTOM");
});

Deno.test("binaryPreviewLine - type · size · preview not available (no dashes)", () => {
  assertEquals(
    binaryPreviewLine("scan.pdf", "application/pdf", 245760),
    "PDF · 240 KB · preview not available",
  );
  assertEquals(
    binaryPreviewLine("README", "application/octet-stream", 512),
    "File · 512 B · preview not available",
  );
});

Deno.test("previewKind - extension fallback when mime is unknown", () => {
  assertEquals(previewKind("pic.png", "application/octet-stream"), "image");
  assertEquals(previewKind("note.md", ""), "text");
  assertEquals(previewKind("scan.pdf", "application/octet-stream"), "binary");
});

Deno.test("binaryPreviewLine - omits the size when unknown", () => {
  assertEquals(
    binaryPreviewLine("scan.pdf", "application/pdf", undefined),
    "PDF · preview not available",
  );
});

// #677: a row inside the server's retention floor needs the admin token to purge, so
// the trash modal asks for it before the server refuses the device token.
Deno.test("purgeNeedsAdmin - true only for a row inside the server's floor", () => {
  const row = (days: number) => ({ trashed_at: NOW - days * DAY });
  assertEquals(purgeNeedsAdmin([row(2)], 30, NOW), true, "a fresh row is inside the floor");
  // Exactly at the boundary the server has not purged it yet, so the admin token is needed.
  assertEquals(purgeNeedsAdmin([row(30)], 30, NOW), true);
  assertEquals(purgeNeedsAdmin([row(30.1)], 30, NOW), false, "past the floor is the device path");
  assertEquals(purgeNeedsAdmin([], 30, NOW), false);
  // Mixed selection: one protected row is enough to need the token for the batch.
  assertEquals(purgeNeedsAdmin([row(40), row(1)], 30, NOW), true);
  // No floor reported (a server without retention_days) has no gate either.
  assertEquals(purgeNeedsAdmin([row(1)], null, NOW), false);
  // A zero floor keeps nothing, so a row even one second old is the device path. The
  // exact boundary counts as inside on both sides: the server purges strictly past it.
  assertEquals(purgeNeedsAdmin([row(0)], 0, NOW), true);
  assertEquals(purgeNeedsAdmin([{ trashed_at: NOW - 1 }], 0, NOW), false);
});
